# frozen_string_literal: true

module Cortoba
  # Console-side configuration, read once from the environment.
  #
  # The KEY NAMES are shared with Cortoba's TypeScript bridge: it writes these
  # custom attributes when it creates a conversation, and this overlay declares
  # the definitions so the console can display and filter on them. Two sides
  # naming the same field differently is how a field silently never renders, so
  # the default lives here once and is overridden by the same env var on both
  # sides.
  module Config
    DEFAULT_RFQ_ATTRIBUTE_KEY = "cortoba_rfq_no"
    DEFAULT_OWNER_ATTRIBUTE_KEY = "cortoba_owner_name"

    module_function

    def rfq_attribute_key
      ENV.fetch("CORTOBA_RFQ_ATTRIBUTE_KEY", DEFAULT_RFQ_ATTRIBUTE_KEY).presence ||
        DEFAULT_RFQ_ATTRIBUTE_KEY
    end

    def owner_attribute_key
      ENV.fetch("CORTOBA_OWNER_ATTRIBUTE_KEY", DEFAULT_OWNER_ATTRIBUTE_KEY).presence ||
        DEFAULT_OWNER_ATTRIBUTE_KEY
    end

    # The Cortoba app the agent clicks through to. Informational only — the
    # console never calls it, so an unset value is not an error.
    def app_url
      ENV.fetch("CORTOBA_APP_URL", "").to_s
    end

    # Custom attributes are account-scoped, and this compose stack provisions a
    # single account. Discover it rather than hard-coding an id, so the overlay
    # works on a fresh database and on an existing one.
    def account
      @account ||= Account.order(:id).first
    end

    def reset_cache!
      @account = nil
    end
  end
end
