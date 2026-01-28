// Simulated notification worker
// In production, this would connect to RabbitMQ

console.log('Notification worker starting...');

const processMessage = (message) => {
  console.log(`Processing notification: ${JSON.stringify(message)}`);
};

// Simulate periodic work
setInterval(() => {
  const mockMessage = {
    type: 'order_update',
    orderId: Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString()
  };
  processMessage(mockMessage);
}, 5000);

console.log('Notification worker ready, waiting for messages...');

// Keep process alive
process.on('SIGTERM', () => {
  console.log('Worker shutting down...');
  process.exit(0);
});
