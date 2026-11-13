# frozen_string_literal: true

# Cortoba overlay — console-side configuration.
#
# Loaded by the official Chatwoot image (see ../Dockerfile). Nothing in
# /app is modified; this file is the only thing that runs at boot, and it only
# *adds* to the console:
#
#   1. Conversation custom attributes so the console shows which pricing request
#      a thread belongs to and which employee owns it. Without them the console
#      shows a supplier thread with no owner, which is the whole problem this
#      integration exists to solve.
#   2. A boot log line naming the Cortoba app URL, so a misconfigured stack is
#      visible immediately rather than at the first supplier reply.
#
# It never fails the boot: a Chatwoot that cannot start because an *optional*
# integration attribute could not be created would be worse than a Chatwoot
# missing one column in its UI.
require "cortoba"

# ── The console answers ONLY the Cortoba gateway ────────────────────────────
#
# Inserted at the TOP of the middleware stack, before anything can render a page
# or answer an API call. A gate mounted later would let a request do work (and
# possibly leak a login page) before being refused.
#
# It is inert until CORTOBA_GATEWAY_SECRET is set, so no existing deployment
# changes behaviour merely by taking this build.
if Cortoba::Config.gateway_enabled?
  Rails.application.config.middleware.insert_before 0, Cortoba::Gateway::Middleware

  Rails.logger.info(
    "[cortoba] private-console gate armed (public paths: " \
    "#{Cortoba::Config.gateway_public_paths.join(', ')})"
  )
else
  Rails.logger.info(
    "[cortoba] private-console gate is OFF — set CORTOBA_GATEWAY_SECRET to " \
    "answer only the gateway"
  )
end

# ── Embedding the console inside the Cortoba app ────────────────────────────
#
# Chatwoot sends `X-Frame-Options: SAMEORIGIN`, so a browser REFUSES to render
# it inside an iframe served from another origin. Measured against the deployed
# console:
#
#   cortoba-chatwoot.onrender.com refused to connect.  ERR_BLOCKED_BY_RESPONSE
#
# The panel is simply blank, which reads as a broken console rather than a
# policy refusal — the operator cannot tell the difference.
#
# The header comes from Rails' `default_headers`, which `ActionDispatch::
# DefaultHeaders` applies on the way OUT. A middleware that merely deletes it
# would have it re-added afterwards and the embed would keep failing while the
# code looked right — so the fix belongs HERE, at the source.
#
# It is replaced by `frame-ancestors` naming exactly the Cortoba app. That is
# STRICTER than what it removes: `SAMEORIGIN` admitted any page on Chatwoot's
# own origin, while the allow-list names one origin and nothing else.
#
# Opt-IN via CORTOBA_ALLOW_FRAMING, so a deployment that has not asked for it
# keeps upstream's protection untouched. Without a resolvable app URL the
# header is KEPT: dropping it with no allow-list would make the console
# embeddable by any site (clickjacking) — worse than a blank panel.
if Cortoba::Config.framing_enabled?
  ancestors = Cortoba::Config.frame_ancestors

  if ancestors.empty?
    Rails.logger.warn(
      "[cortoba] CORTOBA_ALLOW_FRAMING is on but CORTOBA_APP_URL is unset — " \
      "keeping X-Frame-Options so the console cannot be clickjacked"
    )
  else
    Rails.application.config.action_dispatch.default_headers =
      Rails.application.config.action_dispatch.default_headers.except("X-Frame-Options")

    Rails.application.config.action_dispatch.default_headers["Content-Security-Policy"] =
      "frame-ancestors #{ancestors.join(' ')}"

    Rails.logger.info("[cortoba] console embeddable from: #{ancestors.join(', ')}")
  end
end

# Provision the attributes for an account as soon as it exists. The boot pass
# below runs BEFORE the first account on a fresh database, so without this hook
# a documented install ends up with no attributes at all (measured: the boot
# pass returns [] and the console shows no RFQ/owner fields). Provisioning here
# makes the attributes appear on the very first account, whatever the order of
# the README steps.
#
# `to_prepare` (not `on_load(:active_record)`) is what makes this safe: the
# model classes are autoloadable by then, and it re-runs on reload, so the guard
# below keeps the callback from being registered twice.
Rails.application.config.to_prepare do
  next if Account.respond_to?(:cortoba_attribute_hook_installed)

  Account.after_create_commit do
    Cortoba::CustomAttributes.ensure!(self)
    Rails.logger.info("[cortoba] attributes provisioned for account #{id}")
  rescue StandardError => e
    Rails.logger.warn("[cortoba] account #{id} attribute provisioning failed: #{e.class}: #{e.message}")
  end

  Account.define_singleton_method(:cortoba_attribute_hook_installed) { true }
end

Rails.application.config.after_initialize do
  next unless defined?(ActiveRecord::Base)

  begin
    created = Cortoba::CustomAttributes.ensure!
    # An empty result is only normal when there is genuinely no account yet.
    # Saying nothing there is how a fresh install looks configured while having
    # no attributes — the operator then sees a supplier thread with no owner,
    # which is the exact problem this integration exists to solve.
    if created.empty?
      Rails.logger.warn(
        "[cortoba] no account yet — conversation attributes will be provisioned " \
        "automatically when the first account is created"
      )
    else
      Rails.logger.info("[cortoba] conversation attributes ready: #{created.map(&:attribute_key).join(', ')}")
    end
  rescue StandardError => e
    Rails.logger.warn(
      "[cortoba] custom attributes not provisioned: #{e.class}: #{e.message}"
    )
  end

  Rails.logger.info(
    "[cortoba] overlay loaded (rfq=#{Cortoba::Config.rfq_attribute_key} " \
    "owner=#{Cortoba::Config.owner_attribute_key} app=#{Cortoba::Config.app_url.presence || 'unset'})"
  )
end
