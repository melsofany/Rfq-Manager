# frozen_string_literal: true

module Cortoba
  # Makes the console reachable ONLY through the Cortoba gateway.
  #
  # The console is served to agents same-origin at
  # `https://<gateway>/whatsapp/console` by a reverse proxy. Answering a direct
  # visitor at the service's own address would mean a second, unprotected way in
  # — and it would show a Chatwoot login page, which is exactly what must not
  # exist.
  #
  # Render gives no way to make a web service private on a non-Enterprise plan
  # (verified against the live service: the IP allow-list answers "only available
  # for Enterprise workspaces", and `type` cannot be changed after creation). So
  # the wall is built here, in our OWN overlay, instead of in infrastructure we
  # do not control.
  #
  # Two things must both keep working, and both were measured rather than
  # assumed:
  #
  #   * the gateway's proxy, which proves itself with a shared header; and
  #   * Chatwoot's own webhook endpoints, which Meta and Telegram call directly
  #     and which cannot carry our header — they are allow-listed by PATH.
  #
  # What the gate does NOT try to do: authenticate a browser. A visitor with the
  # secret sees the console exactly as the gateway's proxy does, which is the
  # intended single entrance. Anything less would need Chatwoot's own login page
  # to remain reachable, which is the thing being removed.
  class Gateway
    HEADER = "HTTP_X_CORTOBA_GATEWAY"

    # 404, deliberately, and not 403.
    #
    # A 403 confirms the service exists and is simply refusing: it advertises
    # the console and invites a search for the bypass. A direct visitor, and any
    # scanner, gets the same answer an unused hostname gives — there is nothing
    # here. The body is empty for the same reason: no product name, no version,
    # no hint.
    NOT_FOUND_STATUS = 404

    # Paths are matched as PREFIXES so a webhook with an id suffix stays public
    # (`/webhooks/whatsapp/1234`). The comparison is on the path only — a query
    # string must never be able to move a request out of the allow-list.
    def self.public_path?(path, public_paths)
      path = path.to_s
      public_paths.any? { |prefix| path == prefix || path.start_with?("#{prefix}/") }
    end

    # A constant-time comparison: the secret is a shared password, and a timing
    # signal on a password check is a real (if slow) way to recover it.
    def self.valid_secret?(provided, expected)
      return false if provided.nil? || expected.nil?
      return false unless provided.bytesize == expected.bytesize

      Rack::Utils.secure_compare(provided, expected)
    end

    def self.allowed?(env)
      return true unless Cortoba::Config.gateway_enabled?

      path = env["PATH_INFO"]
      return true if public_path?(path, Cortoba::Config.gateway_public_paths)

      # The gateway's proxy presents the shared secret. It is injected as a
      # header by the proxy itself, so a browser cannot forge it without knowing
      # the secret.
      valid_secret?(env[HEADER], Cortoba::Config.gateway_secret)
    end

    # Rack middleware. Wrapped so a failure in the gate can never take the
    # console down: an exception here would 500 every request — including the
    # webhooks that deliver supplier messages — so a broken gate fails OPEN and
    # says so in the log. The console staying reachable is the lesser evil, and
    # the log line makes the misconfiguration visible.
    class Middleware
      def initialize(app)
        @app = app
      end

      def call(env)
        return @app.call(env) if Cortoba::Gateway.allowed?(env)

        [Cortoba::Gateway::NOT_FOUND_STATUS, { "Content-Type" => "text/plain" }, [""]]
      rescue StandardError => e
        Rails.logger.error(
          "[cortoba] gateway gate failed: #{e.class}: #{e.message} — allowing the request"
        )
        @app.call(env)
      end
    end
  end
end
