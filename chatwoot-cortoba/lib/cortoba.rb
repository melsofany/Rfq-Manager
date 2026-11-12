# frozen_string_literal: true

# Cortoba's overlay onto Chatwoot.
#
# Scope rule that keeps this overlay honest: the BUSINESS rules (which pricing
# request a supplier reply answers, which employee owns a request, when to ask
# the supplier to choose) live in ONE place — Cortoba's TypeScript backend, where
# the WhatsApp gateway is. This overlay only does what can ONLY be done inside
# Chatwoot:
#
#   * console configuration (conversation custom attributes)
#   * writing conversations/messages/attachments directly to Chatwoot's database
#     with their ORIGINAL timestamps and ids (the REST API cannot preserve those,
#     so a faithful historical import cannot be done from outside)
#
# Re-implementing the request-resolution rules here would create a second copy of
# one truth, which is the defect class this repository has paid for repeatedly.
module Cortoba
  VERSION = "1.0.0"
end

require "cortoba/config"
require "cortoba/custom_attributes"
require "cortoba/importer"
