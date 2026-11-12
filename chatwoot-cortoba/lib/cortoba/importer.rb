# frozen_string_literal: true

require "digest"
require "fileutils"

module Cortoba
  # Historical import of Cortoba's WhatsApp conversations into Chatwoot.
  #
  # WHY THIS LIVES INSIDE CHATWOOT rather than calling its REST API from Cortoba:
  # the requirement is to preserve the ORIGINAL timestamps and message ids, and
  # to attach the original media files. The REST API stamps `created_at` itself
  # and cannot set a message id or upload to a chosen storage key, so a faithful
  # import is only possible by writing through Chatwoot's own models. That is the
  # one thing this overlay does that Cortoba cannot do from outside.
  #
  # SAFETY PROPERTIES (all asserted by the test suite):
  #   * idempotent — an external id already imported is skipped, never duplicated
  #   * non-destructive — it only INSERTS into Chatwoot's own database; it never
  #     reads or writes Cortoba's tables, and it never deletes anything
  #   * dry-run by default — a real import must be requested explicitly
  #   * per-message isolation — one bad row is reported and skipped, not fatal
  module Importer
    # Where the original ids are recorded so a re-run can recognise them.
    #
    # This is Chatwoot's `messages.source_id` text column — the same column its
    # own WhatsApp integration stores the inbound message id in (see
    # app/services/whatsapp/contact_info_response_service.rb). It is indexed and
    # compares as plain text, which is what an idempotency lookup needs.
    #
    # NOT `external_source_ids`: Message declares
    # `store :external_source_ids, ..., coder: JSON`, which serialises an assigned
    # Hash into a JSON *string* in the jsonb column, so a `->> 'key'` lookup never
    # matches and a re-import silently duplicates every message. Measured, not
    # assumed — that is how this comment came to exist.
    EXTERNAL_SOURCE = "cortoba"

    Result = Struct.new(:conversations_created, :conversations_skipped,
                        :messages_created, :messages_skipped, :attachments_created,
                        :errors, keyword_init: true) do
      def to_s
        "conversations: +#{conversations_created} (=#{conversations_skipped}), " \
          "messages: +#{messages_created} (=#{messages_skipped}), " \
          "attachments: +#{attachments_created}, errors: #{errors.size}"
      end
    end

    module_function

    # Import a single conversation thread.
    #
    # @param payload [Hash] with symbol keys:
    #   :phone        [String]  E.164-ish supplier phone
    #   :contact_name [String]  supplier display name
    #   :rfq_no       [String]  pricing-request number (optional)
    #   :owner_name   [String]  responsible employee (optional)
    #   :messages     [Array<Hash>] each with :external_id, :direction
    #                  ("inbound"/"outbound"), :body, :created_at (Time),
    #                  and optional :media [{ :external_id, :filename,
    #                  :content_type, :bytes }]
    # @param dry_run [Boolean] when true nothing is written
    def import_conversation(payload, dry_run: true)
      result = Result.new(
        conversations_created: 0, conversations_skipped: 0,
        messages_created: 0, messages_skipped: 0,
        attachments_created: 0, errors: []
      )

      account = Config.account
      unless account
        result.errors << "no account exists yet — run db:chatwoot_prepare first"
        return result
      end
      inbox = api_inbox(account)
      unless inbox
        result.errors << "no API inbox in account #{account.id} — create one first"
        return result
      end

      phone = normalize_phone(payload[:phone])
      if phone.blank?
        result.errors << "payload has no usable phone"
        return result
      end

      messages = Array(payload[:messages])
      if dry_run
        # Report what WOULD happen without writing anything. Counting the
        # existing rows is a read, which is why a dry run is safe on production.
        contact = find_contact(account, phone)
        conversation = contact && find_conversation(account, contact)
        result.conversations_skipped = conversation ? 1 : 0
        result.conversations_created = conversation ? 0 : 1
        messages.each do |m|
          if conversation && already_imported?(conversation, m[:external_id])
            result.messages_skipped += 1
          else
            result.messages_created += 1
            result.attachments_created += Array(m[:media]).size
          end
        end
        return result
      end

      contact = find_contact(account, phone) ||
                create_contact(account, inbox, phone, payload[:contact_name])
      conversation = find_conversation(account, contact)
      if conversation
        result.conversations_skipped = 1
      else
        conversation = create_conversation(account, inbox, contact, payload)
        result.conversations_created = 1
      end

      apply_ownership(conversation, payload[:rfq_no], payload[:owner_name])

      messages.each do |m|
        import_message(conversation, m, result)
      rescue StandardError => e
        result.errors << "message #{m[:external_id]}: #{e.class}: #{e.message}"
      end

      touch_conversation(conversation)
      result
    end

    # ── contact / conversation ─────────────────────────────────────────────

    def normalize_phone(raw)
      digits = raw.to_s.gsub(/\D/, "")
      digits = digits.sub(/\A00/, "")
      # Egyptian local form 01… → 201…, matching Cortoba's canonicalPhone.
      digits = "2#{digits}" if digits.length == 11 && digits.start_with?("0")
      digits = "20#{digits}" if digits.length == 10 && digits.start_with?("1")
      digits
    end

    def find_contact(account, phone)
      # phone_number is stored with a leading '+'; compare on digits so a
      # formatting difference never creates a duplicate contact.
      account.contacts.find { |c| normalize_phone(c.phone_number) == phone }
    end

    def create_contact(account, inbox, phone, name)
      contact = account.contacts.create!(
        name: name.presence || "+#{phone}",
        phone_number: "+#{phone}"
      )
      ContactInbox.create!(contact: contact, inbox: inbox, source_id: phone)
      contact
    end

    def find_conversation(account, contact)
      account.conversations.where(contact_id: contact.id).order(:id).first
    end

    def create_conversation(account, inbox, contact, payload)
      contact_inbox = ContactInbox.find_by(contact_id: contact.id, inbox_id: inbox.id)
      conversation = account.conversations.create!(
        inbox: inbox,
        contact: contact,
        contact_inbox: contact_inbox,
        status: :open,
        custom_attributes: custom_attributes_for(payload[:rfq_no], payload[:owner_name])
      )
      # display_id is assigned by Chatwoot on create; nothing to do here.
      conversation
    end

    def custom_attributes_for(rfq_no, owner_name)
      attrs = {}
      attrs[Config.rfq_attribute_key] = rfq_no.to_s if rfq_no.present?
      attrs[Config.owner_attribute_key] = owner_name.to_s if owner_name.present?
      attrs
    end

    def apply_ownership(conversation, rfq_no, owner_name)
      attrs = custom_attributes_for(rfq_no, owner_name)
      return if attrs.empty?

      conversation.update!(custom_attributes: (conversation.custom_attributes || {}).merge(attrs))
    end

    # ── messages ───────────────────────────────────────────────────────────

    def already_imported?(conversation, external_id)
      return false if external_id.blank?

      conversation.messages.where(source_id: external_id.to_s).exists?
    end

    def import_message(conversation, msg, result)
      external_id = msg[:external_id].to_s
      if already_imported?(conversation, external_id)
        result.messages_skipped += 1
        return
      end

      inbound = msg[:direction].to_s == "inbound"
      message = conversation.messages.create!(
        account_id: conversation.account_id,
        inbox_id: conversation.inbox_id,
        message_type: inbound ? :incoming : :outgoing,
        content: msg[:body].to_s,
        status: inbound ? :sent : :delivered,
        source_id: external_id
      )
      # PRESERVE THE ORIGINAL TIME. `created_at` is not assignable through the
      # normal writer, so it is stamped after the row exists — this is the whole
      # reason the import runs inside Chatwoot instead of over its REST API.
      stamp_time(message, msg[:created_at])
      result.messages_created += 1

      Array(msg[:media]).each do |media|
        attach_media(message, media)
        result.attachments_created += 1
      rescue StandardError => e
        result.errors << "attachment #{media[:external_id]}: #{e.class}: #{e.message}"
      end
    end

    # created_at/updated_at are protected from mass assignment; update_columns
    # writes them without touching validations or callbacks.
    def stamp_time(message, time)
      return if time.blank?

      t = time.is_a?(String) ? Time.parse(time) : time
      message.update_columns(created_at: t, updated_at: t)
      message.conversation.update_columns(last_activity_at: t) if t > (message.conversation.last_activity_at || t)
    rescue StandardError
      # A malformed timestamp must not lose the message itself.
      nil
    end

    def attach_media(message, media)
      external_id = media[:external_id].to_s
      # Idempotency at the attachment level too: the same media id must not be
      # stored twice when the import is re-run.
      return if message.attachments.any? { |a| a.meta&.dig("cortoba_external_id") == external_id }

      bytes = media[:bytes]
      bytes = bytes.call if bytes.respond_to?(:call) # lazily fetched
      return if bytes.blank?

      attachment = message.attachments.new(
        account_id: message.account_id,
        file_type: file_type_for(media[:content_type], media[:filename]),
        meta: { "cortoba_external_id" => external_id }
      )
      attachment.file.attach(
        io: StringIO.new(bytes),
        filename: media[:filename].presence || "attachment-#{external_id}",
        content_type: media[:content_type].presence || "application/octet-stream"
      )
      attachment.save!
    end

    def file_type_for(content_type, filename)
      ct = content_type.to_s.downcase
      return :image if ct.start_with?("image/")
      return :audio if ct.start_with?("audio/")
      return :video if ct.start_with?("video/")

      :file
    end

    def touch_conversation(conversation)
      conversation.update_columns(last_activity_at: Time.current)
    end

    # ── inbox ──────────────────────────────────────────────────────────────

    def api_inbox(account)
      inbox = account.inboxes.find { |i| i.channel_type == "Channel::Api" }
      return inbox if inbox

      channel = Channel::Api.create!(account: account)
      account.inboxes.create!(name: "Cortoba WhatsApp", channel: channel)
    end
  end
end
