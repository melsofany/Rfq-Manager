# frozen_string_literal: true

# Cortoba overlay rake tasks.
#
#   rails cortoba:attributes          — provision the conversation custom attributes
#   rails cortoba:import[dry]         — import a thread from JSON on stdin (dry by default)
#   rails cortoba:import_file[/path]  — import from a JSON file
#
# The import reads a JSON payload from stdin/file rather than reaching into
# Cortoba's database: this container has no Cortoba credentials and must not
# need any. Cortoba exports the thread; this side only writes to its own DB.
namespace :cortoba do
  desc "Provision account / admin / API inbox / tokens so Cortoba can connect (idempotent)"
  task bootstrap: :environment do
    result = Cortoba::Bootstrap.run!
    if result[:skipped]
      puts "[cortoba] bootstrap SKIPPED — #{result[:skipped]}"
    else
      puts "[cortoba] created: #{result[:created].join(', ').presence || '(none)'}"
      puts "[cortoba] reused:  #{result[:reused].join(', ').presence || '(none)'}"
    end
  end

  desc "Provision the Cortoba conversation custom attributes (idempotent)"
  task attributes: :environment do
    account = Cortoba::Config.account
    if account.nil?
      abort "[cortoba] no account exists yet — create the first account in the browser, " \
            "then run this task (or let the account-creation hook provision it automatically)"
    end
    created = Cortoba::CustomAttributes.ensure!(account)
    puts "[cortoba] attributes ready for account #{account.id}: #{created.map(&:attribute_key).join(', ')}"
  end

  desc "Import one conversation thread from JSON on stdin (dry run unless FORCE=1)"
  task import: :environment do
    run_import($stdin.read)
  end

  desc "Import one conversation thread from a JSON file (dry run unless FORCE=1)"
  task :import_file, [:path] => :environment do |_t, args|
    path = args[:path].to_s
    abort "[cortoba] usage: rails cortoba:import_file[/path/to/thread.json]" if path.blank?
    abort "[cortoba] no such file: #{path}" unless File.exist?(path)
    run_import(File.read(path))
  end

  desc "Verify the overlay's pure helpers (phone canonicalisation, config keys)"
  task selftest: :environment do
    checks = []
    add = ->(name, ok) { checks << [name, ok] }

    # Phone canonicalisation must match Cortoba's canonicalPhone. A supplier
    # number arrives as bare wa_id digits, with a '+', in local form, or with
    # separators; all of them must resolve to ONE value, or a returning supplier
    # is imported as a second contact.
    {
      "201001234567" => "201001234567",
      "+201001234567" => "201001234567",
      "01001234567" => "201001234567",
      "1001234567" => "201001234567",
      "00201001234567" => "201001234567",
      "20 100 123 4567" => "201001234567"
    }.each do |input, expected|
      got = Cortoba::Importer.normalize_phone(input)
      add.call("normalize_phone(#{input.inspect}) == #{expected.inspect} (got #{got.inspect})", got == expected)
    end

    add.call("rfq attribute key present", Cortoba::Config.rfq_attribute_key.present?)
    add.call("owner attribute key present", Cortoba::Config.owner_attribute_key.present?)

    failed = checks.reject { |_, ok| ok }
    checks.each { |name, ok| puts "  #{ok ? '✓' : '✗'} #{name}" }
    if failed.empty?
      puts "[cortoba] selftest OK (#{checks.size} checks)"
    else
      abort "[cortoba] selftest FAILED (#{failed.size}/#{checks.size})"
    end
  end

  def run_import(raw)
    require "json"
    require "base64"

    payload = JSON.parse(raw, symbolize_names: true)
    dry_run = ENV["FORCE"] != "1"

    # Timestamps arrive as ISO strings; turn them into Times once, here, so the
    # importer itself does not care where the payload came from.
    Array(payload[:messages]).each do |m|
      m[:created_at] = Time.parse(m[:created_at].to_s) if m[:created_at].is_a?(String)
      # JSON cannot carry binary, so media bytes travel base64-encoded. Decode
      # here so the importer receives the same byte string it would get from any
      # other caller. A malformed blob is reported per-attachment rather than
      # failing the whole thread.
      Array(m[:media]).each do |media|
        next unless media[:bytes_base64]

        media[:bytes] = Base64.strict_decode64(media[:bytes_base64].to_s)
      end
    end

    result = Cortoba::Importer.import_conversation(payload, dry_run: dry_run)
    puts "[cortoba] #{dry_run ? 'DRY RUN' : 'IMPORT'} — #{result}"
    result.errors.each { |e| warn "[cortoba] error: #{e}" }
    # A dry run is a report, not a failure; a real run with errors is a failure
    # so CI/cron notices.
    exit(1) if !dry_run && result.errors.any?
  end
end
