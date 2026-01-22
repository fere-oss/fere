#!/usr/bin/env ruby
# Mock service daemon for Fere Dashboard Testing.
# Uses Ruby so the process shows as a generic service type.

require 'socket'

port = (ENV['PORT'] || '7070').to_i
server = TCPServer.new('0.0.0.0', port)

trap('INT') do
  server.close
  exit 0
end

puts "Service mock listening on port #{port}"

loop do
  client = server.accept
  client.puts "service-mock"
  client.close
end
