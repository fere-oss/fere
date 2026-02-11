import { useState, useEffect, useCallback, useMemo } from 'react';
import type { GraphNode, DatabaseTablesResult, TableDataResult, QueryResult, ColumnDefinition } from '../../types/electron';

interface UseDatabasePageResult {
  tables: string[];
  dbType: string;
  selectedTable: string | null;
  tableData: TableDataResult | null;
  query: string;
  queryResult: QueryResult | null;
  loading: boolean;
  loadingTable: boolean;
  executingQuery: boolean;
  error: string | null;
  activeTab: 'data' | 'query';
  showCreateModal: boolean;
  deletingRow: number | null;
  deletingTable: boolean;
  showDeleteConfirm: { rowIndex: number; row: Record<string, unknown> } | null;
  showDeleteTableConfirm: boolean;
  mongoUriInput: string;
  remoteMongoMode: boolean;
  remoteMongoConnecting: boolean;
  mongoUriStatus: 'idle' | 'testing' | 'ok' | 'error';
  mongoUriStatusMessage: string | null;
  recentMongoUris: string[];
  remoteDbOptions: string[];
  remoteCollectionOptions: string[];
  selectedRemoteDb: string;
  selectedRemoteCollection: string;
  setActiveTab: (tab: 'data' | 'query') => void;
  setShowCreateModal: (show: boolean) => void;
  setShowDeleteConfirm: (value: { rowIndex: number; row: Record<string, unknown> } | null) => void;
  setShowDeleteTableConfirm: (value: boolean) => void;
  setMongoUriInput: (value: string) => void;
  setSelectedRemoteDb: (value: string) => void;
  setSelectedRemoteCollection: (value: string) => void;
  setQuery: (value: string) => void;
  testMongoUriConnection: () => Promise<void>;
  connectMongoUriMode: () => Promise<void>;
  disconnectMongoUriMode: () => void;
  loadTableData: (tableName: string) => Promise<void>;
  executeQuery: () => Promise<void>;
  handleKeyDown: (event: React.KeyboardEvent) => void;
  handleCreateTable: (tableName: string, columns: ColumnDefinition[]) => Promise<void>;
  handleDeleteTable: () => Promise<void>;
  handleDeleteRow: (rowIndex: number, row: Record<string, unknown>) => Promise<void>;
  formatCellValue: (value: unknown) => string;
  getDbTypeLabel: () => string;
  getQueryPlaceholder: () => string;
}

export function useDatabasePage(node: GraphNode): UseDatabasePageResult {
  const RECENT_MONGO_URIS_KEY = 'fere.recentMongoUris';
  const [tables, setTables] = useState<string[]>([]);
  const [dbType, setDbType] = useState<string>('database');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<TableDataResult | null>(null);
  const [query, setQuery] = useState('');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingTable, setLoadingTable] = useState(false);
  const [executingQuery, setExecutingQuery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'data' | 'query'>('data');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deletingRow, setDeletingRow] = useState<number | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ rowIndex: number; row: Record<string, unknown> } | null>(null);
  const [deletingTable, setDeletingTable] = useState(false);
  const [showDeleteTableConfirm, setShowDeleteTableConfirm] = useState(false);
  const [mongoUriInput, setMongoUriInput] = useState('');
  const [remoteMongoMode, setRemoteMongoMode] = useState(false);
  const [remoteMongoUri, setRemoteMongoUri] = useState<string | null>(null);
  const [remoteMongoConnecting, setRemoteMongoConnecting] = useState(false);
  const [mongoUriStatus, setMongoUriStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [mongoUriStatusMessage, setMongoUriStatusMessage] = useState<string | null>(null);
  const [recentMongoUris, setRecentMongoUris] = useState<string[]>([]);
  const [selectedRemoteDb, setSelectedRemoteDb] = useState('');
  const [selectedRemoteCollection, setSelectedRemoteCollection] = useState('');
  const containerId = node.containerId || '';
  const containerImage = node.containerImage || '';

  const maskMongoUri = useCallback((uri: string) => {
    const trimmed = uri.trim();
    return trimmed.replace(/(mongodb(?:\+srv)?:\/\/[^:\/?#]+:)([^@]+)(@)/i, '$1<password>$3');
  }, []);

  const parseRemoteTable = useCallback((qualified: string) => {
    const idx = qualified.indexOf('.');
    if (idx <= 0) {
      return { db: '', collection: qualified };
    }
    return {
      db: qualified.slice(0, idx),
      collection: qualified.slice(idx + 1),
    };
  }, []);

  const qualifyRemoteCollection = useCallback((dbName: string, collectionName: string) => {
    if (!collectionName) return '';
    return dbName ? `${dbName}.${collectionName}` : collectionName;
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_MONGO_URIS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setRecentMongoUris(parsed.filter((entry) => typeof entry === 'string').slice(0, 6));
      }
    } catch {
      // Ignore localStorage parse issues
    }
  }, []);

  const saveRecentMongoUri = useCallback((uri: string) => {
    const masked = maskMongoUri(uri);
    setRecentMongoUris((prev) => {
      const next = [masked, ...prev.filter((entry) => entry !== masked)].slice(0, 6);
      try {
        window.localStorage.setItem(RECENT_MONGO_URIS_KEY, JSON.stringify(next));
      } catch {
        // Ignore localStorage write failures
      }
      return next;
    });
  }, [maskMongoUri]);

  useEffect(() => {
    let isCancelled = false;

    const loadTables = async () => {
      if (remoteMongoMode) {
        return;
      }

      if (!window.electronAPI?.getDatabaseTables || !containerId || !containerImage) {
        if (!isCancelled) {
          setError('Database queries not available');
          setLoading(false);
        }
        return;
      }

      try {
        if (!isCancelled) {
          setLoading(true);
          setError(null);
        }
        const result: DatabaseTablesResult = await window.electronAPI.getDatabaseTables(containerId, containerImage);

        if (isCancelled) return;

        if (result.error) {
          setError(result.error);
        } else {
          setTables(result.tables);
          setDbType(result.dbType || 'database');
          if (result.dbType === 'mongodb') {
            setQuery('db.getCollectionNames()');
          } else if (result.dbType === 'postgresql' || result.dbType === 'mysql') {
            setQuery('SELECT * FROM ');
          }
        }
      } catch (err) {
        if (!isCancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load tables');
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    loadTables();
    return () => {
      isCancelled = true;
    };
  }, [containerId, containerImage, remoteMongoMode]);

  const loadTableData = useCallback(async (tableName: string) => {
    if (!window.electronAPI?.getTableData) return;

    try {
      setLoadingTable(true);
      setSelectedTable(tableName);
      setTableData(null);

      const result = remoteMongoMode && remoteMongoUri && window.electronAPI.getMongoUriCollectionData
        ? await window.electronAPI.getMongoUriCollectionData(remoteMongoUri, tableName, 100)
        : await window.electronAPI.getTableData(containerId, containerImage, tableName, 100);
      setTableData(result);
    } catch (err) {
      setTableData({
        columns: [],
        rows: [],
        error: err instanceof Error ? err.message : 'Failed to load data',
      });
    } finally {
      setLoadingTable(false);
    }
  }, [containerId, containerImage, remoteMongoMode, remoteMongoUri]);

  const refreshTables = useCallback(async () => {
    try {
      if (remoteMongoMode && remoteMongoUri && window.electronAPI?.connectMongoUri) {
        const result: DatabaseTablesResult = await window.electronAPI.connectMongoUri(remoteMongoUri);
        if (!result.error) {
          setTables(result.tables);
          setDbType('mongodb');
        }
        return;
      }

      if (!window.electronAPI?.getDatabaseTables || !containerId || !containerImage) {
        return;
      }

      const result: DatabaseTablesResult = await window.electronAPI.getDatabaseTables(containerId, containerImage);
      if (!result.error) {
        setTables(result.tables);
        setDbType(result.dbType || 'database');
      }
    } catch (err) {
      console.error('Error refreshing tables:', err);
    }
  }, [containerId, containerImage, remoteMongoMode, remoteMongoUri]);

  const applyRemoteTableDefaults = useCallback((remoteTables: string[]) => {
    if (remoteTables.length === 0) {
      setSelectedRemoteDb('');
      setSelectedRemoteCollection('');
      return;
    }
    const first = parseRemoteTable(remoteTables[0]);
    setSelectedRemoteDb(first.db);
    setSelectedRemoteCollection(first.collection);
  }, [parseRemoteTable]);

  const testMongoUriConnection = useCallback(async () => {
    if (!window.electronAPI?.connectMongoUri || !mongoUriInput.trim()) {
      setMongoUriStatus('error');
      setMongoUriStatusMessage('Enter a MongoDB URI to test');
      return;
    }

    try {
      setMongoUriStatus('testing');
      setMongoUriStatusMessage('Testing connection...');
      const result = await window.electronAPI.connectMongoUri(mongoUriInput.trim());
      if (result.error) {
        setMongoUriStatus('error');
        setMongoUriStatusMessage(result.error);
        return;
      }
      setMongoUriStatus('ok');
      setMongoUriStatusMessage(`Connected (${result.tables?.length || 0} collections found)`);
      saveRecentMongoUri(mongoUriInput.trim());
    } catch (err) {
      setMongoUriStatus('error');
      setMongoUriStatusMessage(err instanceof Error ? err.message : 'Connection test failed');
    }
  }, [mongoUriInput, saveRecentMongoUri]);

  const connectMongoUriMode = useCallback(async () => {
    if (!window.electronAPI?.connectMongoUri || !mongoUriInput.trim()) {
      setError('Enter a MongoDB URI to connect');
      return;
    }

    try {
      setRemoteMongoConnecting(true);
      setMongoUriStatus('testing');
      setMongoUriStatusMessage('Connecting...');
      setError(null);
      const result = await window.electronAPI.connectMongoUri(mongoUriInput.trim());
      if (result.error) {
        setError(result.error);
        setMongoUriStatus('error');
        setMongoUriStatusMessage(result.error);
        return;
      }

      setRemoteMongoUri(mongoUriInput.trim());
      setRemoteMongoMode(true);
      setDbType('mongodb');
      setTables(result.tables || []);
      applyRemoteTableDefaults(result.tables || []);
      setSelectedTable(null);
      setTableData(null);
      setQuery('db.getCollectionNames()');
      setLoading(false);
      setMongoUriStatus('ok');
      setMongoUriStatusMessage('Connected');
      saveRecentMongoUri(mongoUriInput.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect MongoDB URI');
      setMongoUriStatus('error');
      setMongoUriStatusMessage(err instanceof Error ? err.message : 'Failed to connect MongoDB URI');
    } finally {
      setRemoteMongoConnecting(false);
    }
  }, [mongoUriInput, applyRemoteTableDefaults, saveRecentMongoUri]);

  const disconnectMongoUriMode = useCallback(() => {
    setRemoteMongoMode(false);
    setRemoteMongoUri(null);
    setSelectedTable(null);
    setTableData(null);
    setQueryResult(null);
    setError(null);
    setSelectedRemoteDb('');
    setSelectedRemoteCollection('');
    setMongoUriStatus('idle');
    setMongoUriStatusMessage(null);
  }, []);

  const normalizeExecutableQuery = useCallback((rawQuery: string) => {
    let nextQuery = rawQuery.trim();

    // Users sometimes paste escaped newlines (\n) as text. PostgreSQL/MySQL
    // treat those as invalid slash/meta commands when sent literally.
    if (dbType === 'postgresql' || dbType === 'mysql') {
      nextQuery = nextQuery
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
    }

    return nextQuery;
  }, [dbType]);

  const executeQuery = useCallback(async () => {
    if (!window.electronAPI?.executeDatabaseQuery) return;

    const executableQuery = normalizeExecutableQuery(query);
    if (!executableQuery) return;

    try {
      setExecutingQuery(true);
      setQueryResult(null);

      const result = remoteMongoMode && remoteMongoUri && window.electronAPI.executeMongoUriQuery
        ? await window.electronAPI.executeMongoUriQuery(remoteMongoUri, executableQuery)
        : await window.electronAPI.executeDatabaseQuery(containerId, containerImage, executableQuery);
      setQueryResult(result);

      if (!result.error) {
        await refreshTables();
        if (selectedTable) {
          await loadTableData(selectedTable);
        }
      }
    } catch (err) {
      setQueryResult({
        error: err instanceof Error ? err.message : 'Query execution failed',
      });
    } finally {
      setExecutingQuery(false);
    }
  }, [containerId, containerImage, query, refreshTables, selectedTable, loadTableData, normalizeExecutableQuery, remoteMongoMode, remoteMongoUri]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      executeQuery();
    }
  }, [executeQuery]);

  const handleCreateTable = useCallback(async (tableName: string, columns: ColumnDefinition[]) => {
    if (remoteMongoMode && remoteMongoUri && dbType === 'mongodb') {
      if (!window.electronAPI?.executeMongoUriQuery) {
        throw new Error('Remote MongoDB query API not available');
      }

      const safeName = tableName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const result = await window.electronAPI.executeMongoUriQuery(remoteMongoUri, `db.createCollection("${safeName}")`);
      if (result.error) throw new Error(result.error);
      await refreshTables();
      setActiveTab('data');
      await loadTableData(tableName);
      return;
    }

    if (!window.electronAPI?.createDatabaseTable) {
      throw new Error('Create table API not available. Please restart the Electron app.');
    }

    const result = await window.electronAPI.createDatabaseTable(containerId, containerImage, tableName, columns);

    if (result.error) {
      throw new Error(result.error);
    }

    await refreshTables();
    setActiveTab('data');
    await loadTableData(tableName);
  }, [containerId, containerImage, refreshTables, loadTableData, remoteMongoMode, remoteMongoUri, dbType]);

  const handleDeleteTable = useCallback(async () => {
    if (!selectedTable || !window.electronAPI?.executeDatabaseQuery) return;

    const escapePostgres = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const escapeMySQL = (name: string) => `\`${name.replace(/`/g, '``')}\``;
    const escapeMongo = (name: string) => name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    let dropQuery = '';
    if (dbType === 'postgresql') {
      dropQuery = `DROP TABLE IF EXISTS ${escapePostgres(selectedTable)} CASCADE;`;
    } else if (dbType === 'mysql') {
      dropQuery = `DROP TABLE IF EXISTS ${escapeMySQL(selectedTable)};`;
    } else if (dbType === 'mongodb') {
      dropQuery = `db.getCollection("${escapeMongo(selectedTable)}").drop()`;
    } else {
      alert('Unsupported database type for deleting tables.');
      return;
    }

    setDeletingTable(true);
    try {
      const result = remoteMongoMode && remoteMongoUri && window.electronAPI.executeMongoUriQuery
        ? await window.electronAPI.executeMongoUriQuery(remoteMongoUri, dropQuery)
        : await window.electronAPI.executeDatabaseQuery(containerId, containerImage, dropQuery);
      if (result.error) {
        throw new Error(result.error);
      }
      setShowDeleteTableConfirm(false);
      setSelectedTable(null);
      setTableData(null);
      await refreshTables();
    } catch (error) {
      console.error('Error deleting table:', error);
      alert(`Failed to delete ${dbType === 'mongodb' ? 'collection' : 'table'}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDeletingTable(false);
    }
  }, [selectedTable, dbType, containerId, containerImage, refreshTables, remoteMongoMode, remoteMongoUri]);

  const handleDeleteRow = useCallback(async (rowIndex: number, row: Record<string, unknown>) => {
    if (!selectedTable || !tableData) return;

    setDeletingRow(rowIndex);

    try {
      const whereClauses = tableData.columns.map((col) => {
        const value = row[col];
        if (value === null || value === undefined) {
          return `${col} IS NULL`;
        } else if (typeof value === 'string') {
          const escapedValue = value.replace(/'/g, "''");
          return `${col} = '${escapedValue}'`;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          return `${col} = ${value}`;
        } else {
          const escapedValue = JSON.stringify(value).replace(/'/g, "''");
          return `${col}::text = '${escapedValue}'`;
        }
      });

      const deleteQuery = `DELETE FROM ${selectedTable} WHERE ${whereClauses.join(' AND ')};`;

      const result = await window.electronAPI.executeDatabaseQuery(containerId, containerImage, deleteQuery);

      if (result.error) {
        throw new Error(result.error);
      }

      await loadTableData(selectedTable);
      setShowDeleteConfirm(null);
    } catch (error) {
      console.error('Error deleting row:', error);
      alert(`Failed to delete row: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDeletingRow(null);
    }
  }, [selectedTable, tableData, containerId, containerImage, loadTableData]);

  const formatCellValue = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const getDbTypeLabel = () => {
    switch (dbType) {
      case 'postgresql': return 'PostgreSQL';
      case 'mysql': return 'MySQL';
      case 'mongodb': return 'MongoDB';
      default: return 'Database';
    }
  };

  const getQueryPlaceholder = () => {
    switch (dbType) {
      case 'postgresql':
        return `-- PostgreSQL Query Editor\n-- Press Cmd/Ctrl + Enter to execute\n\nSELECT * FROM users LIMIT 10;\n\n-- More examples:\n-- INSERT INTO users (name, email) VALUES ('John', 'john@example.com');\n-- CREATE TABLE products (id SERIAL PRIMARY KEY, name VARCHAR(100));`;
      case 'mysql':
        return `-- MySQL Query Editor\n-- Press Cmd/Ctrl + Enter to execute\n\nSELECT * FROM users LIMIT 10;\n\n-- More examples:\n-- INSERT INTO users (name, email) VALUES ('John', 'john@example.com');\n-- CREATE TABLE products (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100));`;
      case 'mongodb':
        return `// MongoDB Shell\n// Press Cmd/Ctrl + Enter to execute\n\ndb.users.find().limit(10)\n\n// More examples:\n// db.users.insertOne({name: \"John\", email: \"john@example.com\"})\n// db.createCollection(\"products\")`;
      default:
        return 'Enter your query here...';
    }
  };

  const remoteDbOptions = useMemo(() => {
    if (!remoteMongoMode) return [];
    const dbSet = new Set<string>();
    tables.forEach((qualified) => {
      const { db } = parseRemoteTable(qualified);
      dbSet.add(db);
    });
    return Array.from(dbSet);
  }, [tables, remoteMongoMode, parseRemoteTable]);

  const remoteCollectionOptions = useMemo(() => {
    if (!remoteMongoMode) return [];
    return tables
      .map((qualified) => parseRemoteTable(qualified))
      .filter(({ db }) => db === selectedRemoteDb)
      .map(({ collection }) => collection);
  }, [tables, remoteMongoMode, parseRemoteTable, selectedRemoteDb]);

  const setMongoUriInputWithReset = useCallback((value: string) => {
    setMongoUriInput(value);
    setMongoUriStatus('idle');
    setMongoUriStatusMessage(null);
  }, []);

  const setSelectedRemoteDbWithSelection = useCallback((dbName: string) => {
    setSelectedRemoteDb(dbName);
    const firstMatch = tables
      .map((qualified) => parseRemoteTable(qualified))
      .find((entry) => entry.db === dbName);
    const collection = firstMatch?.collection || '';
    setSelectedRemoteCollection(collection);
    const qualified = qualifyRemoteCollection(dbName, collection);
    if (qualified) {
      loadTableData(qualified);
    }
  }, [tables, parseRemoteTable, qualifyRemoteCollection, loadTableData]);

  const setSelectedRemoteCollectionWithLoad = useCallback((collectionName: string) => {
    setSelectedRemoteCollection(collectionName);
    const qualified = qualifyRemoteCollection(selectedRemoteDb, collectionName);
    if (qualified) {
      loadTableData(qualified);
    }
  }, [selectedRemoteDb, qualifyRemoteCollection, loadTableData]);

  return {
    tables,
    dbType,
    selectedTable,
    tableData,
    query,
    queryResult,
    loading,
    loadingTable,
    executingQuery,
    error,
    activeTab,
    showCreateModal,
    deletingRow,
    showDeleteConfirm,
    deletingTable,
    showDeleteTableConfirm,
    mongoUriInput,
    remoteMongoMode,
    remoteMongoConnecting,
    mongoUriStatus,
    mongoUriStatusMessage,
    recentMongoUris,
    remoteDbOptions,
    remoteCollectionOptions,
    selectedRemoteDb,
    selectedRemoteCollection,
    setActiveTab,
    setShowCreateModal,
    setShowDeleteConfirm,
    setShowDeleteTableConfirm,
    setMongoUriInput: setMongoUriInputWithReset,
    setSelectedRemoteDb: setSelectedRemoteDbWithSelection,
    setSelectedRemoteCollection: setSelectedRemoteCollectionWithLoad,
    setQuery,
    testMongoUriConnection,
    connectMongoUriMode,
    disconnectMongoUriMode,
    loadTableData,
    executeQuery,
    handleKeyDown,
    handleCreateTable,
    handleDeleteTable,
    handleDeleteRow,
    formatCellValue,
    getDbTypeLabel,
    getQueryPlaceholder,
  };
}
