import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Typography,
  Container,
  Grid,
  Card,
  CardContent,
  CardActions,
  Button,
  Paper,
  Box,
  Chip,
  LinearProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Tooltip,
  Badge,
  Drawer,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  CssBaseline,
  ThemeProvider,
  createTheme,
} from '@mui/material';
import {
  Dashboard,
  Storage,
  Code,
  Speed,
  Schedule,
  Settings,
  Refresh,
  PlayArrow,
  Stop,
  Delete,
  Edit,
  Visibility,
  CloudUpload,
  Download,
  Timeline,
  Assessment,
  BugReport,
  Security,
  Api,
  MenuOpen,
  Notifications,
} from '@mui/icons-material';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';
import axios from 'axios';

// Types
interface ServiceHealth {
  status: string;
  timestamp: string;
  services: Record<string, string>;
  uptime: string;
  version: string;
  memory?: {
    alloc: number;
    total_alloc: number;
    sys: number;
    num_gc: number;
  };
}

interface Task {
  id: string;
  name: string;
  description: string;
  command: string;
  schedule: string;
  enabled: boolean;
  last_run: string;
  status: string;
}

interface Job {
  id: string;
  name: string;
  status: 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  created_at: string;
  started_at?: string;
  completed_at?: string;
  input_count: number;
  processed_count: number;
  error_count: number;
}

interface SystemMetrics {
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  active_jobs: number;
  total_records_processed: number;
  average_processing_time_ms: number;
  error_rate: number;
  uptime_seconds: number;
}

interface CodeTemplate {
  name: string;
  description: string;
  language: string;
  content: string;
}

// API Service
class ApiService {
  private baseUrls = {
    gateway: 'http://localhost:3000',
    database: 'http://localhost:5000',
    generator: 'http://localhost:8080',
    performance: 'http://localhost:9000',
    automation: 'http://localhost:7000',
    goService: 'http://localhost:8080',
    rustProcessor: 'http://localhost:8000',
  };

  async fetchHealth(service: keyof typeof this.baseUrls): Promise<ServiceHealth> {
    const response = await axios.get(`${this.baseUrls[service]}/health`);
    return response.data;
  }

  async fetchTasks(): Promise<Task[]> {
    const response = await axios.get(`${this.baseUrls.automation}/tasks`);
    return response.data;
  }

  async executeTask(taskId: string): Promise<any> {
    const response = await axios.post(`${this.baseUrls.automation}/tasks/${taskId}/execute`);
    return response.data;
  }

  async addTask(task: Partial<Task>): Promise<any> {
    const response = await axios.post(`${this.baseUrls.automation}/tasks`, task);
    return response.data;
  }

  async fetchJobs(): Promise<Job[]> {
    const response = await axios.get(`${this.baseUrls.rustProcessor}/jobs`);
    return response.data;
  }

  async fetchMetrics(service: keyof typeof this.baseUrls): Promise<SystemMetrics> {
    const response = await axios.get(`${this.baseUrls[service]}/metrics`);
    return response.data;
  }

  async fetchTemplates(): Promise<CodeTemplate[]> {
    const response = await axios.get(`${this.baseUrls.generator}/api/templates`);
    return response.data;
  }

  async generateCode(templateName: string, parameters: Record<string, string>): Promise<any> {
    const response = await axios.post(`${this.baseUrls.generator}/api/generate`, {
      templateName,
      parameters,
    });
    return response.data;
  }

  async fetchDatabases(): Promise<any> {
    const response = await axios.get(`${this.baseUrls.database}/connections`);
    return response.data;
  }

  async executeQuery(connectionName: string, query: string): Promise<any> {
    const response = await axios.post(`${this.baseUrls.database}/query/${connectionName}`, {
      query,
    });
    return response.data;
  }
}

const apiService = new ApiService();

// Theme
const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#1976d2',
    },
    secondary: {
      main: '#dc004e',
    },
    background: {
      default: '#121212',
      paper: '#1e1e1e',
    },
  },
});

// Components
const Dashboard: React.FC = () => {
  const [healthData, setHealthData] = useState<Record<string, ServiceHealth>>({});
  const [metricsData, setMetricsData] = useState<Record<string, SystemMetrics>>({});
  const [loading, setLoading] = useState(true);

  const fetchDashboardData = useCallback(async () => {
    try {
      setLoading(true);
      const services = ['gateway', 'database', 'generator', 'performance', 'automation'] as const;
      
      const healthPromises = services.map(async (service) => {
        try {
          const health = await apiService.fetchHealth(service);
          return { service, health };
        } catch {
          return { service, health: null };
        }
      });

      const metricsPromises = services.map(async (service) => {
        try {
          const metrics = await apiService.fetchMetrics(service);
          return { service, metrics };
        } catch {
          return { service, metrics: null };
        }
      });

      const healthResults = await Promise.all(healthPromises);
      const metricsResults = await Promise.all(metricsPromises);

      const newHealthData: Record<string, ServiceHealth> = {};
      const newMetricsData: Record<string, SystemMetrics> = {};

      healthResults.forEach(({ service, health }) => {
        if (health) newHealthData[service] = health;
      });

      metricsResults.forEach(({ service, metrics }) => {
        if (metrics) newMetricsData[service] = metrics;
      });

      setHealthData(newHealthData);
      setMetricsData(newMetricsData);
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return 'success';
      case 'unhealthy': return 'error';
      default: return 'warning';
    }
  };

  const chartData = Object.entries(metricsData).map(([service, metrics]) => ({
    name: service,
    cpu: metrics.cpu_usage,
    memory: metrics.memory_usage,
    disk: metrics.disk_usage,
  }));

  if (loading) {
    return <LinearProgress />;
  }

  return (
    <Container maxWidth="xl">
      <Box mb={3}>
        <Typography variant="h4" gutterBottom>
          Development Toolkit Dashboard
        </Typography>
        <Button
          variant="outlined"
          startIcon={<Refresh />}
          onClick={fetchDashboardData}
          sx={{ mb: 2 }}
        >
          Refresh
        </Button>
      </Box>

      <Grid container spacing={3}>
        {/* Service Health Cards */}
        {Object.entries(healthData).map(([service, health]) => (
          <Grid item xs={12} sm={6} md={4} key={service}>
            <Card>
              <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="center">
                  <Typography variant="h6" component="div">
                    {service.charAt(0).toUpperCase() + service.slice(1)}
                  </Typography>
                  <Chip
                    label={health.status}
                    color={getStatusColor(health.status) as any}
                    size="small"
                  />
                </Box>
                <Typography color="text.secondary" gutterBottom>
                  Version: {health.version}
                </Typography>
                <Typography color="text.secondary">
                  Uptime: {health.uptime}
                </Typography>
                {health.memory && (
                  <Typography color="text.secondary" fontSize="0.8rem">
                    Memory: {Math.round(health.memory.alloc / 1024 / 1024)}MB
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
        ))}

        {/* System Metrics Chart */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                System Resource Usage
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <RechartsTooltip />
                  <Legend />
                  <Bar dataKey="cpu" fill="#8884d8" name="CPU %" />
                  <Bar dataKey="memory" fill="#82ca9d" name="Memory %" />
                  <Bar dataKey="disk" fill="#ffc658" name="Disk %" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Quick Stats */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                System Overview
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <Paper sx={{ p: 2, textAlign: 'center' }}>
                    <Typography variant="h4" color="primary">
                      {Object.keys(healthData).length}
                    </Typography>
                    <Typography variant="body2">Active Services</Typography>
                  </Paper>
                </Grid>
                <Grid item xs={6}>
                  <Paper sx={{ p: 2, textAlign: 'center' }}>
                    <Typography variant="h4" color="secondary">
                      {Object.values(metricsData).reduce((sum, m) => sum + m.active_jobs, 0)}
                    </Typography>
                    <Typography variant="body2">Active Jobs</Typography>
                  </Paper>
                </Grid>
                <Grid item xs={6}>
                  <Paper sx={{ p: 2, textAlign: 'center' }}>
                    <Typography variant="h4" color="success.main">
                      {Object.values(metricsData).reduce((sum, m) => sum + m.total_records_processed, 0)}
                    </Typography>
                    <Typography variant="body2">Records Processed</Typography>
                  </Paper>
                </Grid>
                <Grid item xs={6}>
                  <Paper sx={{ p: 2, textAlign: 'center' }}>
                    <Typography variant="h4" color="warning.main">
                      {(Object.values(metricsData).reduce((sum, m) => sum + m.error_rate, 0) / Object.values(metricsData).length || 0).toFixed(2)}%
                    </Typography>
                    <Typography variant="body2">Error Rate</Typography>
                  </Paper>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>

        {/* Performance Timeline */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Performance Timeline
              </Typography>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <RechartsTooltip />
                  <Line type="monotone" dataKey="cpu" stroke="#8884d8" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Container>
  );
};

const TaskAutomation: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newTask, setNewTask] = useState<Partial<Task>>({
    name: '',
    description: '',
    command: '',
    schedule: '',
    enabled: true,
  });

  useEffect(() => {
    fetchTasks();
  }, []);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const taskList = await apiService.fetchTasks();
      setTasks(taskList);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteTask = async (taskId: string) => {
    try {
      await apiService.executeTask(taskId);
      fetchTasks();
    } catch (error) {
      console.error('Failed to execute task:', error);
    }
  };

  const handleAddTask = async () => {
    try {
      await apiService.addTask(newTask);
      setDialogOpen(false);
      setNewTask({
        name: '',
        description: '',
        command: '',
        schedule: '',
        enabled: true,
      });
      fetchTasks();
    } catch (error) {
      console.error('Failed to add task:', error);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success': return 'success';
      case 'failed': return 'error';
      case 'running': return 'warning';
      default: return 'default';
    }
  };

  return (
    <Container maxWidth="xl">
      <Box mb={3} display="flex" justifyContent="space-between" alignItems="center">
        <Typography variant="h4">Task Automation</Typography>
        <Button
          variant="contained"
          startIcon={<Schedule />}
          onClick={() => setDialogOpen(true)}
        >
          Add Task
        </Button>
      </Box>

      {loading ? (
        <LinearProgress />
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Command</TableCell>
                <TableCell>Schedule</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Last Run</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <Typography variant="subtitle2">{task.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {task.description}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <code style={{ fontSize: '0.8rem' }}>{task.command}</code>
                  </TableCell>
                  <TableCell>{task.schedule || 'Manual'}</TableCell>
                  <TableCell>
                    <Chip
                      label={task.status}
                      color={getStatusColor(task.status) as any}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>
                    {task.last_run ? new Date(task.last_run).toLocaleString() : 'Never'}
                  </TableCell>
                  <TableCell>
                    <Tooltip title="Execute">
                      <IconButton
                        onClick={() => handleExecuteTask(task.id)}
                        color="primary"
                      >
                        <PlayArrow />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Edit">
                      <IconButton color="secondary">
                        <Edit />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton color="error">
                        <Delete />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add Task Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Add New Task</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2} mt={1}>
            <TextField
              label="Task Name"
              value={newTask.name}
              onChange={(e) => setNewTask({ ...newTask, name: e.target.value })}
              fullWidth
            />
            <TextField
              label="Description"
              value={newTask.description}
              onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
              fullWidth
              multiline
              rows={2}
            />
            <TextField
              label="Command"
              value={newTask.command}
              onChange={(e) => setNewTask({ ...newTask, command: e.target.value })}
              fullWidth
              multiline
              rows={3}
            />
            <TextField
              label="Schedule (Cron Expression)"
              value={newTask.schedule}
              onChange={(e) => setNewTask({ ...newTask, schedule: e.target.value })}
              fullWidth
              placeholder="0 */6 * * *"
              helperText="Leave empty for manual execution"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleAddTask} variant="contained">
            Add Task
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

const CodeGenerator: React.FC = () => {
  const [templates, setTemplates] = useState<CodeTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [generatedCode, setGeneratedCode] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      const templateList = await apiService.fetchTemplates();
      setTemplates(Object.values(templateList));
    } catch (error) {
      console.error('Failed to fetch templates:', error);
    }
  };

  const handleGenerateCode = async () => {
    if (!selectedTemplate) return;

    try {
      setLoading(true);
      const result = await apiService.generateCode(selectedTemplate, parameters);
      setGeneratedCode(result.generated_code);
    } catch (error) {
      console.error('Failed to generate code:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleParameterChange = (key: string, value: string) => {
    setParameters(prev => ({ ...prev, [key]: value }));
  };

  return (
    <Container maxWidth="xl">
      <Typography variant="h4" gutterBottom>
        Code Generator
      </Typography>

      <Grid container spacing={3}>
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Templates
              </Typography>
              <FormControl fullWidth sx={{ mb: 2 }}>
                <InputLabel>Select Template</InputLabel>
                <Select
                  value={selectedTemplate}
                  onChange={(e) => setSelectedTemplate(e.target.value)}
                >
                  {templates.map((template) => (
                    <MenuItem key={template.name} value={template.name}>
                      {template.description} ({template.language})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              {selectedTemplate && (
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Parameters
                  </Typography>
                  {['CLASS_NAME', 'PACKAGE', 'DESCRIPTION', 'ENTITY', 'ENDPOINT'].map((param) => (
                    <TextField
                      key={param}
                      label={param}
                      value={parameters[param] || ''}
                      onChange={(e) => handleParameterChange(param, e.target.value)}
                      fullWidth
                      sx={{ mb: 1 }}
                      size="small"
                    />
                  ))}

                  <Button
                    variant="contained"
                    onClick={handleGenerateCode}
                    loading={loading}
                    startIcon={<Code />}
                    fullWidth
                    sx={{ mt: 2 }}
                  >
                    Generate Code
                  </Button>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={8}>
          <Card sx={{ height: '600px' }}>
            <CardContent sx={{ height: '100%' }}>
              <Typography variant="h6" gutterBottom>
                Generated Code
              </Typography>
              <Paper
                sx={{
                  height: 'calc(100% - 40px)',
                  p: 2,
                  backgroundColor: '#1e1e1e',
                  overflow: 'auto',
                }}
              >
                <pre style={{ color: '#fff', fontSize: '0.8rem', margin: 0 }}>
                  {generatedCode || 'Select a template and click "Generate Code" to see the result here.'}
                </pre>
              </Paper>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Container>
  );
};

const DatabaseManager: React.FC = () => {
  const [connections, setConnections] = useState<Record<string, any>>({});
  const [selectedConnection, setSelectedConnection] = useState<string>('');
  const [query, setQuery] = useState<string>('SELECT * FROM users LIMIT 10;');
  const [queryResult, setQueryResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchConnections();
  }, []);

  const fetchConnections = async () => {
    try {
      const connectionList = await apiService.fetchDatabases();
      setConnections(connectionList);
    } catch (error) {
      console.error('Failed to fetch connections:', error);
    }
  };

  const handleExecuteQuery = async () => {
    if (!selectedConnection || !query) return;

    try {
      setLoading(true);
      const result = await apiService.executeQuery(selectedConnection, query);
      setQueryResult(result);
    } catch (error) {
      console.error('Failed to execute query:', error);
      setQueryResult({ error: 'Query execution failed' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxWidth="xl">
      <Typography variant="h4" gutterBottom>
        Database Manager
      </Typography>

      <Grid container spacing={3}>
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Connections
              </Typography>
              <FormControl fullWidth sx={{ mb: 2 }}>
                <InputLabel>Select Connection</InputLabel>
                <Select
                  value={selectedConnection}
                  onChange={(e) => setSelectedConnection(e.target.value)}
                >
                  {Object.entries(connections).map(([name, conn]) => (
                    <MenuItem key={name} value={name}>
                      {name} ({conn.type})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Typography variant="subtitle2" gutterBottom>
                Quick Actions
              </Typography>
              <Box display="flex" flexDirection="column" gap={1}>
                <Button variant="outlined" size="small">
                  Show Tables
                </Button>
                <Button variant="outlined" size="small">
                  Export Data
                </Button>
                <Button variant="outlined" size="small">
                  Backup Database
                </Button>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={8}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                SQL Query
              </Typography>
              <TextField
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                multiline
                rows={6}
                fullWidth
                sx={{ mb: 2, fontFamily: 'monospace' }}
              />
              <Button
                variant="contained"
                onClick={handleExecuteQuery}
                loading={loading}
                startIcon={<PlayArrow />}
                disabled={!selectedConnection}
              >
                Execute Query
              </Button>

              {queryResult && (
                <Box mt={3}>
                  <Typography variant="h6" gutterBottom>
                    Results
                  </Typography>
                  <Paper sx={{ p: 2, maxHeight: '400px', overflow: 'auto' }}>
                    {queryResult.error ? (
                      <Alert severity="error">{queryResult.error}</Alert>
                    ) : (
                      <pre style={{ fontSize: '0.8rem' }}>
                        {JSON.stringify(queryResult, null, 2)}
                      </pre>
                    )}
                  </Paper>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Container>
  );
};

// Main App Component
const App: React.FC = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const menuItems = [
    { text: 'Dashboard', icon: <Dashboard />, path: '/' },
    { text: 'Database Manager', icon: <Storage />, path: '/database' },
    { text: 'Code Generator', icon: <Code />, path: '/generator' },
    { text: 'Task Automation', icon: <Schedule />, path: '/automation' },
    { text: 'Performance', icon: <Speed />, path: '/performance' },
    { text: 'Settings', icon: <Settings />, path: '/settings' },
  ];

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Router>
        <Box sx={{ display: 'flex' }}>
          <AppBar position="fixed" sx={{ zIndex: theme.zIndex.drawer + 1 }}>
            <Toolbar>
              <IconButton
                color="inherit"
                onClick={() => setDrawerOpen(!drawerOpen)}
                edge="start"
                sx={{ mr: 2 }}
              >
                <MenuOpen />
              </IconButton>
              <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                Development Toolkit
              </Typography>
              <Badge badgeContent={4} color="secondary">
                <Notifications />
              </Badge>
            </Toolbar>
          </AppBar>

          <Drawer
            variant="persistent"
            anchor="left"
            open={drawerOpen}
            sx={{
              width: 240,
              flexShrink: 0,
              '& .MuiDrawer-paper': {
                width: 240,
                boxSizing: 'border-box',
              },
            }}
          >
            <Toolbar />
            <List>
              {menuItems.map((item) => (
                <ListItem
                  key={item.text}
                  component={Link}
                  to={item.path}
                  onClick={() => setDrawerOpen(false)}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.text} />
                </ListItem>
              ))}
            </List>
          </Drawer>

          <Box
            component="main"
            sx={{
              flexGrow: 1,
              bgcolor: 'background.default',
              p: 3,
              transition: theme.transitions.create('margin', {
                easing: theme.transitions.easing.sharp,
                duration: theme.transitions.duration.leavingScreen,
              }),
              marginLeft: drawerOpen ? 0 : '-240px',
            }}
          >
            <Toolbar />
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/database" element={<DatabaseManager />} />
              <Route path="/generator" element={<CodeGenerator />} />
              <Route path="/automation" element={<TaskAutomation />} />
              <Route path="/performance" element={<Dashboard />} />
              <Route path="/settings" element={<Dashboard />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Box>
        </Box>
      </Router>
    </ThemeProvider>
  );
};

export default App;
