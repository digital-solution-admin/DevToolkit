require 'json'
require 'net/http'
require 'uri'
require 'sqlite3'
require 'csv'
require 'date'
require 'optparse'

class DataAnalyzer
  def initialize
    @db = SQLite3::Database.new "analytics.db"
    create_tables
  end

  def create_tables
    @db.execute <<-SQL
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY,
        event_name VARCHAR(255),
        payload TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    SQL
  end

  def record_event(event_name, payload)
    @db.execute("INSERT INTO logs (event_name, payload) VALUES (?, ?)", [event_name, payload.to_json])
  end

  def analyze_events
    rows = @db.execute("SELECT event_name, COUNT(*) as count FROM logs GROUP BY event_name")
    rows.each do |row|
      puts "Event: {row[0]}, Count: {row[1]}"
    end
  end

  def export_to_csv(file_path)
    CSV.open(file_path, "w") do |csv|
      csv << ["ID", "Event Name", "Payload", "Created At"]
      @db.execute("SELECT * FROM logs") do |row|
        csv << row
      end
    end
  end

  def fetch_data_from_api(api_url)
    uri = URI.parse(api_url)
    response = Net::HTTP.get_response(uri)
    JSON.parse(response.body)
  end
end

options = {}
OptionParser.new do |opts|
  opts.banner = "Usage: ruby_data_analyzer.rb [options]"

  opts.on("-e", "--event EVENT", "Record an event") do |event|
    options[:event] = event
  end

  opts.on("-p", "--payload PAYLOAD", "Payload for the event (JSON format)") do |payload|
    options[:payload] = JSON.parse(payload)
  end

  opts.on("-a", "--analyze", "Analyze events") do
    options[:analyze] = true
  end

  opts.on("-c", "--csv FILE", "Export events to CSV file") do |file|
    options[:csv] = file
  end

  opts.on("-f", "--fetch API_URL", "Fetch data from API URL") do |url|
    options[:fetch] = url
  end
end.parse!

data_analyzer = DataAnalyzer.new

if options[:event] && options[:payload]
  data_analyzer.record_event(options[:event], options[:payload])
  puts "Event recorded: #{options[:event]}"
end

if options[:analyze]
  data_analyzer.analyze_events
end

if options[:csv]
  data_analyzer.export_to_csv(options[:csv])
  puts "Data exported to #{options[:csv]}"
end

if options[:fetch]
  data = data_analyzer.fetch_data_from_api(options[:fetch])
  puts "Data fetched: #{data}"
end

