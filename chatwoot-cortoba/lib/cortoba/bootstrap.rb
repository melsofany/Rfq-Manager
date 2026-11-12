# frozen_string_literal: true

module Cortoba
  # Turn a freshly migrated Chatwoot into a CONNECTED one, without a human
  # clicking through the setup wizard.
  #
  # The gap this closes: the console boots and serves perfectly, but Cortoba's
  # bridge needs four things that only exist after someone signs up in a browser —
  # an account, an admin user, an API inbox, and two tokens. A deploy that ends
  # with "Chatwoot is running" and no token has not integrated anything, so the
  # provisioning is code and runs on every boot (idempotent).
  #
  # Idempotent by IDENTITY, not by a flag: the account is found by name, the user
  # by email, the inbox by (account, name). Re-running after a partial failure
  # finishes the job instead of creating a second account.
  module Bootstrap
    API_INBOX_NAME = "Cortoba API"

    module_function

    # Every step reports what it found or made, so the boot log is evidence
    # rather than a claim.
    def run!
      result = { created: [], reused: [], errors: [] }
      email = ENV["CORTOBA_ADMIN_EMAIL"].to_s.strip
      password = ENV["CORTOBA_ADMIN_PASSWORD"].to_s

      if email.blank? || password.blank?
        # Not an error: a deployment that has not been given admin credentials is
        # expected to be finished in the browser. Say so plainly rather than
        # failing the boot, because the console is still usable by hand.
        result[:skipped] = "CORTOBA_ADMIN_EMAIL / CORTOBA_ADMIN_PASSWORD not set"
        return result
      end

      account = ensure_account(result)
      user = ensure_admin(account, email, password, result)
      inbox = ensure_api_inbox(account, result)
      ensure_tokens(account, user, inbox, result)
      result
    end

    def ensure_account(result)
      name = ENV.fetch("CORTOBA_ACCOUNT_NAME", "Cortoba").to_s.strip
      account = Account.find_by(name: name)
      if account
        result[:reused] << "account #{account.id}"
        return account
      end
      account = Account.create!(name: name)
      result[:created] << "account #{account.id}"
      account
    end

    def ensure_admin(account, email, password, result)
      user = User.find_by(email: email)
      if user.nil?
        user = User.new(name: ENV.fetch("CORTOBA_ADMIN_NAME", "Cortoba Admin"),
                        email: email, password: password)
        user.skip_confirmation!
        user.save!
        result[:created] << "user #{user.id}"
      else
        result[:reused] << "user #{user.id}"
      end

      unless account.administrators.exists?(id: user.id)
        AccountUser.create!(account: account, user: user, role: :administrator)
        result[:created] << "administrator link"
      end
      user
    end

    # The bridge talks to an API-channel inbox. It must NOT be a WhatsApp inbox:
    # Meta's webhook stays pointed at Cortoba, which is the ONE gateway. An API
    # inbox is just a place to file conversations the bridge mirrors in.
    def ensure_api_inbox(account, result)
      inbox = account.inboxes.find_by(name: API_INBOX_NAME)
      if inbox
        result[:reused] << "inbox #{inbox.id}"
        return inbox
      end
      # The channel row must be persisted BEFORE the inbox references it:
      # `inboxes.channel_id` is NOT NULL, and an unsaved `Channel::Api.new` gives
      # the inbox a null id. Chatwoot's own seeders create the channel first for
      # the same reason.
      channel = Channel::Api.create!(account: account)
      inbox = account.inboxes.create!(name: API_INBOX_NAME, channel_id: channel.id,
                                      channel_type: "Channel::Api")
      result[:created] << "inbox #{inbox.id}"
      inbox
    end

    # Tokens are pinned from the environment when supplied, so the values on the
    # Cortoba service and the values here cannot drift apart. `has_secure_token`
    # uses `||=`, so an explicitly assigned token survives the create callback.
    def ensure_tokens(account, user, inbox, result)
      api_token = ENV["CORTOBA_CHATWOOT_API_TOKEN"].to_s.strip
      if api_token.present?
        tok = user.access_token || user.create_access_token
        if tok.token != api_token
          tok.update!(token: api_token)
          result[:created] << "api token (pinned)"
        else
          result[:reused] << "api token"
        end
      end

      platform_token = ENV["CORTOBA_CHATWOOT_PLATFORM_TOKEN"].to_s.strip
      if platform_token.present?
        app = PlatformApp.find_by(name: "Cortoba") || PlatformApp.create!(name: "Cortoba")
        tok = app.access_token || app.create_access_token
        if tok.token != platform_token
          tok.update!(token: platform_token)
          result[:created] << "platform token (pinned)"
        else
          result[:reused] << "platform token"
        end
        # A platform app only sees accounts it is permitted to.
        unless app.platform_app_permissibles.exists?(permissible: account)
          PlatformAppPermissible.create!(platform_app: app, permissible: account)
          result[:created] << "platform app permission"
        end
      end

      # The attributes the bridge writes must exist or Chatwoot rejects them.
      Cortoba::CustomAttributes.ensure!(account)
      result[:reused] << "custom attributes"
    end
  end
end
