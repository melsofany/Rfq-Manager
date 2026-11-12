# frozen_string_literal: true

module Cortoba
  # Declares the conversation custom attributes the console displays.
  #
  # Idempotent by construction: it finds-or-creates by (account, attribute_key,
  # attribute_model), which is the same triple Chatwoot enforces with a unique
  # index. Running it on every boot is therefore safe, and running it on a fresh
  # database is how the attributes come into existence at all.
  #
  # It deliberately does NOT touch a definition that already exists: an operator
  # may have renamed the display label or reordered the list in the UI, and a
  # boot-time overwrite would silently undo their change on every deploy.
  module CustomAttributes
    DEFINITIONS = [
      {
        key: -> { Config.rfq_attribute_key },
        display_name: "طلب التسعير (RFQ)",
        description: "رقم طلب التسعير الذي تخصّه هذه المحادثة. يُكتب من Cortoba.",
        display_type: :text
      },
      {
        key: -> { Config.owner_attribute_key },
        display_name: "الموظف المسؤول",
        description: "الموظف المسؤول عن طلب التسعير، وهو من تُحوَّل إليه المحادثة.",
        display_type: :text
      }
    ].freeze

    module_function

    # @return [Array<CustomAttributeDefinition>] the definitions, created or existing
    def ensure!
      account = Config.account
      return [] unless account

      DEFINITIONS.filter_map do |spec|
        key = spec[:key].call
        next if key.blank?

        existing = CustomAttributeDefinition.find_by(
          account_id: account.id,
          attribute_key: key,
          attribute_model: :conversation_attribute
        )
        next existing if existing

        CustomAttributeDefinition.create!(
          account_id: account.id,
          attribute_key: key,
          attribute_display_name: spec[:display_name],
          attribute_description: spec[:description],
          attribute_model: :conversation_attribute,
          attribute_display_type: spec[:display_type]
        )
      end
    end
  end
end
