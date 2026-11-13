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

    # The Cortoba app the agent clicks through to. It is ALSO the origin allowed
    # to embed the console (see Cortoba::FrameHeaders), so an unset value is no
    # longer cosmetic: without it the console stays un-embeddable and the agent
    # gets a blank panel.
    def app_url
      ENV.fetch("CORTOBA_APP_URL", "").to_s.strip
    end

    # Extra origins allowed to embed the console, comma-separated. Needed when
    # the app answers on more than one host (a custom domain alongside the
    # onrender.com one). An origin missing from the list renders a BLANK panel
    # with no error, so this is the knob to reach for when the embed works on
    # one host and not another.
    def extra_frame_ancestors
      ENV.fetch("CORTOBA_FRAME_ANCESTORS", "").to_s.split(",").map(&:strip).reject(&:empty?)
    end

    # Every origin permitted to frame the console, the app URL first.
    def frame_ancestors
      [app_url] + extra_frame_ancestors
    end

    # Framing is opt-IN: a deployment that has not asked for it keeps upstream's
    # X-Frame-Options, so the default posture stays the safe one.
    #
    # Read through an explicit truthy list rather than "is it set?". `present?`
    # would treat the literal string "false" as enabled — the opposite of what
    # an operator writing CORTOBA_ALLOW_FRAMING=false means, and it would widen
    # a security header based on a value that reads as a refusal.
    def framing_enabled?
      %w[1 true yes on].include?(ENV.fetch("CORTOBA_ALLOW_FRAMING", "").to_s.strip.downcase)
    end

    def account_name
      ENV.fetch("CORTOBA_ACCOUNT_NAME", "Cortoba").to_s.strip
    end

    # Custom attributes are account-scoped, so the overlay must resolve the SAME
    # account Cortoba's bridge talks to.
    #
    # Resolving by lowest id is what this used to do, and it is WRONG as soon as
    # a second account exists: measured on the live stack, the bootstrap created
    # "Cortoba" as account 3 while a leftover account 2 was still present, so
    # `Account.order(:id).first` pointed the overlay at account 2 — attributes on
    # one account, conversations on another. Resolve by NAME, which is the same
    # identity the bootstrap provisions with, so the two cannot disagree.
    #
    # The API-inbox tie-break matters when a name is reused: the account that
    # carries the Cortoba API inbox is the one the integration actually uses.
    def account
      @account ||= resolve_account
    end

    def resolve_account
      named = Account.where(name: account_name).order(:id).to_a
      return named.first if named.one?

      if named.many?
        with_inbox = named.find { |a| a.inboxes.exists?(name: Cortoba::Bootstrap::API_INBOX_NAME) }
        chosen = with_inbox || named.first
        Rails.logger.warn(
          "[cortoba] #{named.size} accounts named #{account_name.inspect}; " \
          "using #{chosen.id} (matched by #{with_inbox ? 'API inbox' : 'lowest id'})"
        )
        return chosen
      end

      Account.order(:id).first
    end

    def reset_cache!
      @account = nil
    end
  end
end
