// Keyed by target node type + optional port
const CONNECTION_LABELS: Record<string, string> = {
  'database:5432': 'queries PostgreSQL',
  'database:3306': 'queries MySQL',
  'database:27017': 'reads/writes MongoDB',
  'cache:6379': 'caches via Redis',
  'broker:5672': 'publishes to RabbitMQ',
  'broker:9092': 'produces to Kafka',
  'frontend:3000': 'serves frontend',
  'frontend:5173': 'serves frontend',
  'webserver:80': 'proxied by Nginx',
  'webserver:443': 'proxied by Nginx',
};

// Fallback by type only
const TYPE_LABELS: Record<string, string> = {
  'database': 'queries database',
  'cache': 'uses cache',
  'broker': 'sends messages',
  'frontend': 'serves frontend',
  'backend': 'calls API',
  'webserver': 'proxied by server',
};

export function getConnectionLabel(targetType: string, targetPort: number): string | null {
  return CONNECTION_LABELS[`${targetType}:${targetPort}`]
    || TYPE_LABELS[targetType]
    || null;
}
