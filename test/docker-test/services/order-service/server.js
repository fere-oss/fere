const express = require('express');
const app = express();

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'order-service' });
});

app.get('/api/orders', (req, res) => {
  res.json([
    { id: 1, userId: 1, total: 99.99, status: 'completed' },
    { id: 2, userId: 2, total: 149.99, status: 'pending' }
  ]);
});

app.post('/api/orders', (req, res) => {
  res.status(201).json({ id: 3, ...req.body, status: 'created' });
});

app.get('/api/orders/:id', (req, res) => {
  res.json({ id: req.params.id, userId: 1, total: 99.99, status: 'completed' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Order service running on port ${PORT}`);
});
