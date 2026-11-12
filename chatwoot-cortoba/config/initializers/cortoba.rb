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

Rails.application.config.after_initialize do
  next unless defined?(ActiveRecord::Base)

  begin
    Cortoba::CustomAttributes.ensure!
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
