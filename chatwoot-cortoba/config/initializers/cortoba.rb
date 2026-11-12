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
