# frozen_string_literal: true
#
# Guards the private-console gate.
#
# Runs INSIDE the pinned Chatwoot image, against its real Rack and its real
# `Rack::Utils.secure_compare` — the gate is the only thing standing between the
# public internet and a console that must be reachable from the Cortoba gateway
# alone, so "the code looks right" is not an acceptable form of proof here.
#
# Run with (from chatwoot-cortoba/):
#
#   docker run --rm \
#     -v "$PWD/lib/cortoba/gateway.rb:/app/lib/cortoba/gateway.rb:ro" \
#     -v "$PWD/spec:/app/spec:ro" \
#     --entrypoint sh chatwoot/chatwoot:v4.19.1-ce \
#     -c 'cd /app && bundle exec ruby -Ilib spec/gateway_spec.rb'
#
# No database is needed: the gate reads the environment and nothing else, which
# is deliberate — a gate that depended on a query could fail open when the
# database is down, and this one must not.

require "rack"

# Stub Config so the gate can be exercised without booting the whole app. The
# gate reads every decision from Config, so this is the real seam.
module Cortoba
  module Config
    def self.gateway_enabled?
      true
    end

    def self.gateway_secret
      "s3cret"
    end

    def self.gateway_public_paths
      ["/health", "/webhooks/whatsapp"]
    end
  end
end

require "cortoba/gateway"

$failures = 0

def check(label, got, want)
  ok = got == want
  puts "  #{ok ? 'PASS' : 'FAIL'} #{label}: got=#{got.inspect} want=#{want.inspect}"
  $failures += 1 unless ok
  ok
end

puts "=== public_path? matches on PREFIX, never on a partial word ==="
check("exact", Cortoba::Gateway.public_path?("/health", ["/health"]), true)
check(
  "prefix with an id suffix",
  Cortoba::Gateway.public_path?("/webhooks/whatsapp/123", ["/webhooks/whatsapp"]),
  true
)
# A bare `start_with?` would make `/healthzzz` public. It must not.
check(
  "a longer word is NOT a prefix match",
  Cortoba::Gateway.public_path?("/healthzzz", ["/health"]),
  false
)
check("an unrelated path", Cortoba::Gateway.public_path?("/app/login", ["/health"]), false)

puts "=== valid_secret? ==="
check("the correct secret", Cortoba::Gateway.valid_secret?("s3cret", "s3cret"), true)
check("a wrong secret", Cortoba::Gateway.valid_secret?("nope", "s3cret"), false)
check("a missing secret", Cortoba::Gateway.valid_secret?(nil, "s3cret"), false)
# Length-checked before comparison, so the constant-time path is only reached
# for equal-length inputs.
check("a shorter secret", Cortoba::Gateway.valid_secret?("s3cre", "s3cret"), false)

puts "=== allowed? — a console is unreachable without the gateway header ==="
check(
  "the API WITH the secret",
  Cortoba::Gateway.allowed?(
    { "PATH_INFO" => "/api/v1/accounts", "HTTP_X_CORTOBA_GATEWAY" => "s3cret" }
  ),
  true
)
check(
  "the API WITHOUT the secret is refused",
  Cortoba::Gateway.allowed?({ "PATH_INFO" => "/api/v1/accounts" }),
  false
)
# The login page is the exact thing the user asked not to exist. A direct
# visitor must not even be told there is a console here.
check(
  "the login page is refused",
  Cortoba::Gateway.allowed?({ "PATH_INFO" => "/app/login" }),
  false
)
check(
  "compiled assets are refused too",
  Cortoba::Gateway.allowed?({ "PATH_INFO" => "/vite/assets/x.js" }),
  false
)
# Chatwoot's own webhook endpoints are called by Meta directly and can never
# carry our header; allow-listing them by path is what keeps supplier messaging
# working.
check("the health probe stays public", Cortoba::Gateway.allowed?({ "PATH_INFO" => "/health" }), true)
check(
  "the WhatsApp webhook stays public",
  Cortoba::Gateway.allowed?({ "PATH_INFO" => "/webhooks/whatsapp/123" }),
  true
)
# A query string must not be able to move a request into the public list.
check(
  "a public path with a query still matches on path alone",
  Cortoba::Gateway.allowed?({ "PATH_INFO" => "/health", "QUERY_STRING" => "x=1" }),
  true
)
check(
  "a forged query on a private path does not help",
  Cortoba::Gateway.allowed?(
    { "PATH_INFO" => "/app/login", "QUERY_STRING" => "/health" }
  ),
  false
)

puts "=== the middleware answers 404 with an EMPTY body (no product hint) ==="
mw = Cortoba::Gateway::Middleware.new(->(_env) { [200, {}, ["OK"]] })
status, _headers, body = mw.call({ "PATH_INFO" => "/app/login" })
check("status for a direct visitor", status, 404)
check("body is empty", body.join, "")

status_gateway, _, _ = mw.call(
  { "PATH_INFO" => "/app/login", "HTTP_X_CORTOBA_GATEWAY" => "s3cret" }
)
check("the gateway passes through", status_gateway, 200)

puts $failures.zero? ? "\nALL PASS" : "\n#{$failures} FAILURE(S)"
exit($failures.zero? ? 0 : 1)
