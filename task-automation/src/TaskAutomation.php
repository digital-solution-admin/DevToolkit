<?php

namespace DevToolkit\TaskAutomation;

require_once 'vendor/autoload.php';

use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\HttpKernel;
use Symfony\Component\HttpKernel\Controller\ControllerResolver;
use Symfony\Component\HttpKernel\Controller\ArgumentResolver;
use Symfony\Component\Routing\Matcher\UrlMatcher;
use Symfony\Component\Routing\RequestContext;
use Symfony\Component\Routing\RouteCollection;
use Symfony\Component\Routing\Route;
use Monolog\Logger;
use Monolog\Handler\StreamHandler;
use Monolog\Handler\RotatingFileHandler;
use Cron\CronExpression;

/**
 * Task Automation System
 * Handles scheduled tasks, job execution, and workflow automation
 */
class TaskAutomationService
{
    private $logger;
    private $tasks = [];
    private $jobs = [];
    private $workflows = [];
    private $isRunning = false;
    private $database;
    
    public function __construct()
    {
        $this->logger = new Logger('TaskAutomation');
        $this->logger->pushHandler(new RotatingFileHandler('logs/automation.log', 0, Logger::DEBUG));
        $this->logger->pushHandler(new StreamHandler('php://stdout', Logger::INFO));
        
        $this->initializeDatabase();
        $this->loadTasks();
        
        $this->logger->info('Task Automation Service initialized');
    }
    
    /**
     * Initialize SQLite database for task storage
     */
    private function initializeDatabase()
    {
        try {
            $this->database = new \PDO('sqlite:data/automation.db');
            $this->database->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            
            // Create tables
            $this->database->exec("
                CREATE TABLE IF NOT EXISTS tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name VARCHAR(255) NOT NULL,
                    description TEXT,
                    command TEXT NOT NULL,
                    schedule VARCHAR(255),
                    enabled BOOLEAN DEFAULT 1,
                    last_run DATETIME,
                    next_run DATETIME,
                    status VARCHAR(50) DEFAULT 'pending',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ");
            
            $this->database->exec("
                CREATE TABLE IF NOT EXISTS job_executions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id INTEGER,
                    started_at DATETIME,
                    finished_at DATETIME,
                    status VARCHAR(50),
                    output TEXT,
                    error_output TEXT,
                    exit_code INTEGER,
                    FOREIGN KEY (task_id) REFERENCES tasks (id)
                )
            ");
            
            $this->database->exec("
                CREATE TABLE IF NOT EXISTS workflows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name VARCHAR(255) NOT NULL,
                    description TEXT,
                    steps TEXT, -- JSON
                    enabled BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ");
            
            $this->logger->info('Database initialized successfully');
            
        } catch (\Exception $e) {
            $this->logger->error('Database initialization failed: ' . $e->getMessage());
            throw $e;
        }
    }
    
    /**
     * Load tasks from database
     */
    private function loadTasks()
    {
        try {
            $stmt = $this->database->query("SELECT * FROM tasks WHERE enabled = 1");
            $this->tasks = $stmt->fetchAll(\PDO::FETCH_ASSOC);
            
            foreach ($this->tasks as &$task) {
                if ($task['schedule']) {
                    $cron = new CronExpression($task['schedule']);
                    $task['next_run'] = $cron->getNextRunDate()->format('Y-m-d H:i:s');
                }
            }
            
            $this->logger->info('Loaded ' . count($this->tasks) . ' tasks');
            
        } catch (\Exception $e) {
            $this->logger->error('Failed to load tasks: ' . $e->getMessage());
        }
    }
    
    /**
     * Add a new task
     */
    public function addTask($name, $command, $schedule = null, $description = '')
    {
        try {
            $stmt = $this->database->prepare("
                INSERT INTO tasks (name, description, command, schedule, enabled)
                VALUES (?, ?, ?, ?, 1)
            ");
            
            $stmt->execute([$name, $description, $command, $schedule]);
            $taskId = $this->database->lastInsertId();
            
            $this->loadTasks(); // Reload tasks
            
            $this->logger->info("Added new task: $name (ID: $taskId)");
            
            return [
                'success' => true,
                'task_id' => $taskId,
                'message' => 'Task added successfully'
            ];
            
        } catch (\Exception $e) {
            $this->logger->error('Failed to add task: ' . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Execute a task by ID
     */
    public function executeTask($taskId)
    {
        try {
            $stmt = $this->database->prepare("SELECT * FROM tasks WHERE id = ?");
            $stmt->execute([$taskId]);
            $task = $stmt->fetch(\PDO::FETCH_ASSOC);
            
            if (!$task) {
                throw new \Exception("Task not found: $taskId");
            }
            
            $this->logger->info("Executing task: {$task['name']}");
            
            // Record job start
            $jobId = $this->recordJobStart($taskId);
            
            $startTime = microtime(true);
            $command = $this->parseCommand($task['command']);
            
            // Execute command
            $descriptorspec = [
                0 => ["pipe", "r"],
                1 => ["pipe", "w"],
                2 => ["pipe", "w"]
            ];
            
            $process = proc_open($command, $descriptorspec, $pipes);
            
            if (is_resource($process)) {
                fclose($pipes[0]);
                
                $output = stream_get_contents($pipes[1]);
                $errorOutput = stream_get_contents($pipes[2]);
                
                fclose($pipes[1]);
                fclose($pipes[2]);
                
                $exitCode = proc_close($process);
                $endTime = microtime(true);
                $duration = $endTime - $startTime;
                
                // Update task last run
                $this->updateTaskLastRun($taskId);
                
                // Record job completion
                $this->recordJobCompletion($jobId, $output, $errorOutput, $exitCode);
                
                $status = $exitCode === 0 ? 'success' : 'failed';
                
                $this->logger->info("Task completed: {$task['name']} - Status: $status - Duration: {$duration}s");
                
                return [
                    'success' => $exitCode === 0,
                    'task_id' => $taskId,
                    'job_id' => $jobId,
                    'output' => $output,
                    'error_output' => $errorOutput,
                    'exit_code' => $exitCode,
                    'duration' => $duration,
                    'status' => $status
                ];
                
            } else {
                throw new \Exception('Failed to start process');
            }
            
        } catch (\Exception $e) {
            $this->logger->error("Task execution failed: " . $e->getMessage());
            
            if (isset($jobId)) {
                $this->recordJobCompletion($jobId, '', $e->getMessage(), -1);
            }
            
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Parse command with variables
     */
    private function parseCommand($command)
    {
        $variables = [
            '{DATE}' => date('Y-m-d'),
            '{TIME}' => date('H:i:s'),
            '{TIMESTAMP}' => time(),
            '{DATETIME}' => date('Y-m-d H:i:s'),
            '{PROJECT_ROOT}' => getcwd(),
            '{TEMP_DIR}' => sys_get_temp_dir()
        ];
        
        return str_replace(array_keys($variables), array_values($variables), $command);
    }
    
    /**
     * Start the task scheduler
     */
    public function startScheduler()
    {
        if ($this->isRunning) {
            return ['success' => false, 'message' => 'Scheduler already running'];
        }
        
        $this->isRunning = true;
        $this->logger->info('Task scheduler started');
        
        // Run scheduler loop
        while ($this->isRunning) {
            try {
                $this->checkScheduledTasks();
                sleep(30); // Check every 30 seconds
                
            } catch (\Exception $e) {
                $this->logger->error('Scheduler error: ' . $e->getMessage());
            }
        }
        
        return ['success' => true, 'message' => 'Scheduler started'];
    }
    
    /**
     * Stop the task scheduler
     */
    public function stopScheduler()
    {
        $this->isRunning = false;
        $this->logger->info('Task scheduler stopped');
        
        return ['success' => true, 'message' => 'Scheduler stopped'];
    }
    
    /**
     * Check for scheduled tasks that need to run
     */
    private function checkScheduledTasks()
    {
        $now = new \DateTime();
        
        foreach ($this->tasks as $task) {
            if (!$task['schedule'] || !$task['enabled']) {
                continue;
            }
            
            try {
                $cron = new CronExpression($task['schedule']);
                
                if ($cron->isDue($now)) {
                    $this->logger->info("Running scheduled task: {$task['name']}");
                    
                    // Execute task in background
                    $this->executeTaskAsync($task['id']);
                }
                
            } catch (\Exception $e) {
                $this->logger->error("Error checking schedule for task {$task['id']}: " . $e->getMessage());
            }
        }
    }
    
    /**
     * Execute task asynchronously
     */
    private function executeTaskAsync($taskId)
    {
        // In a real implementation, you might use a queue system or background job processor
        // For now, we'll just execute in a separate process
        
        $command = "php -r \"
            require_once 'TaskAutomation.php';
            \$service = new DevToolkit\\TaskAutomation\\TaskAutomationService();
            \$service->executeTask($taskId);
        \" > /dev/null 2>&1 &";
        
        exec($command);
    }
    
    /**
     * Create a workflow
     */
    public function createWorkflow($name, $steps, $description = '')
    {
        try {
            $stmt = $this->database->prepare("
                INSERT INTO workflows (name, description, steps, enabled)
                VALUES (?, ?, ?, 1)
            ");
            
            $stmt->execute([$name, $description, json_encode($steps)]);
            $workflowId = $this->database->lastInsertId();
            
            $this->logger->info("Created workflow: $name (ID: $workflowId)");
            
            return [
                'success' => true,
                'workflow_id' => $workflowId,
                'message' => 'Workflow created successfully'
            ];
            
        } catch (\Exception $e) {
            $this->logger->error('Failed to create workflow: ' . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Execute a workflow
     */
    public function executeWorkflow($workflowId)
    {
        try {
            $stmt = $this->database->prepare("SELECT * FROM workflows WHERE id = ?");
            $stmt->execute([$workflowId]);
            $workflow = $stmt->fetch(\PDO::FETCH_ASSOC);
            
            if (!$workflow) {
                throw new \Exception("Workflow not found: $workflowId");
            }
            
            $steps = json_decode($workflow['steps'], true);
            $results = [];
            
            $this->logger->info("Executing workflow: {$workflow['name']}");
            
            foreach ($steps as $index => $step) {
                $this->logger->info("Executing step $index: {$step['name']}");
                
                $stepResult = $this->executeWorkflowStep($step);
                $results[] = $stepResult;
                
                // Stop execution if step failed and it's marked as critical
                if (!$stepResult['success'] && ($step['critical'] ?? false)) {
                    $this->logger->error("Critical step failed, stopping workflow execution");
                    break;
                }
            }
            
            return [
                'success' => true,
                'workflow_id' => $workflowId,
                'results' => $results
            ];
            
        } catch (\Exception $e) {
            $this->logger->error("Workflow execution failed: " . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Execute a single workflow step
     */
    private function executeWorkflowStep($step)
    {
        switch ($step['type']) {
            case 'task':
                return $this->executeTask($step['task_id']);
                
            case 'command':
                return $this->executeCommand($step['command']);
                
            case 'http_request':
                return $this->executeHttpRequest($step);
                
            case 'file_operation':
                return $this->executeFileOperation($step);
                
            case 'delay':
                sleep($step['seconds'] ?? 1);
                return ['success' => true, 'message' => 'Delay completed'];
                
            default:
                return ['success' => false, 'error' => 'Unknown step type: ' . $step['type']];
        }
    }
    
    /**
     * Execute a command step
     */
    private function executeCommand($command)
    {
        try {
            $output = [];
            $exitCode = 0;
            
            exec($this->parseCommand($command), $output, $exitCode);
            
            return [
                'success' => $exitCode === 0,
                'output' => implode("\n", $output),
                'exit_code' => $exitCode
            ];
            
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Execute HTTP request step
     */
    private function executeHttpRequest($step)
    {
        try {
            $ch = curl_init();
            
            curl_setopt($ch, CURLOPT_URL, $step['url']);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_TIMEOUT, $step['timeout'] ?? 30);
            
            if (isset($step['method'])) {
                curl_setopt($ch, CURLOPT_CUSTOMREQUEST, strtoupper($step['method']));
            }
            
            if (isset($step['headers'])) {
                curl_setopt($ch, CURLOPT_HTTPHEADER, $step['headers']);
            }
            
            if (isset($step['data'])) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $step['data']);
            }
            
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $error = curl_error($ch);
            
            curl_close($ch);
            
            if ($error) {
                throw new \Exception($error);
            }
            
            return [
                'success' => $httpCode >= 200 && $httpCode < 300,
                'http_code' => $httpCode,
                'response' => $response
            ];
            
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Execute file operation step
     */
    private function executeFileOperation($step)
    {
        try {
            switch ($step['operation']) {
                case 'copy':
                    $success = copy($step['source'], $step['destination']);
                    break;
                    
                case 'move':
                    $success = rename($step['source'], $step['destination']);
                    break;
                    
                case 'delete':
                    $success = unlink($step['file']);
                    break;
                    
                case 'create_directory':
                    $success = mkdir($step['directory'], 0755, true);
                    break;
                    
                case 'write_file':
                    $success = file_put_contents($step['file'], $step['content']) !== false;
                    break;
                    
                default:
                    throw new \Exception('Unknown file operation: ' . $step['operation']);
            }
            
            return [
                'success' => $success,
                'operation' => $step['operation']
            ];
            
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Get system status
     */
    public function getStatus()
    {
        return [
            'scheduler_running' => $this->isRunning,
            'total_tasks' => count($this->tasks),
            'enabled_tasks' => count(array_filter($this->tasks, function($task) {
                return $task['enabled'];
            })),
            'total_workflows' => count($this->workflows),
            'system_info' => [
                'php_version' => PHP_VERSION,
                'memory_usage' => memory_get_usage(true),
                'memory_peak' => memory_get_peak_usage(true),
                'uptime' => time() - $_SERVER['REQUEST_TIME_FLOAT']
            ]
        ];
    }
    
    /**
     * Get all tasks
     */
    public function getTasks()
    {
        return $this->tasks;
    }
    
    /**
     * Get task execution history
     */
    public function getTaskHistory($taskId = null, $limit = 50)
    {
        try {
            $sql = "SELECT je.*, t.name as task_name 
                    FROM job_executions je 
                    JOIN tasks t ON je.task_id = t.id";
            
            $params = [];
            
            if ($taskId) {
                $sql .= " WHERE je.task_id = ?";
                $params[] = $taskId;
            }
            
            $sql .= " ORDER BY je.started_at DESC LIMIT ?";
            $params[] = $limit;
            
            $stmt = $this->database->prepare($sql);
            $stmt->execute($params);
            
            return $stmt->fetchAll(\PDO::FETCH_ASSOC);
            
        } catch (\Exception $e) {
            $this->logger->error('Failed to get task history: ' . $e->getMessage());
            return [];
        }
    }
    
    /**
     * Record job start
     */
    private function recordJobStart($taskId)
    {
        $stmt = $this->database->prepare("
            INSERT INTO job_executions (task_id, started_at, status)
            VALUES (?, datetime('now'), 'running')
        ");
        
        $stmt->execute([$taskId]);
        return $this->database->lastInsertId();
    }
    
    /**
     * Record job completion
     */
    private function recordJobCompletion($jobId, $output, $errorOutput, $exitCode)
    {
        $status = $exitCode === 0 ? 'success' : 'failed';
        
        $stmt = $this->database->prepare("
            UPDATE job_executions 
            SET finished_at = datetime('now'), status = ?, output = ?, error_output = ?, exit_code = ?
            WHERE id = ?
        ");
        
        $stmt->execute([$status, $output, $errorOutput, $exitCode, $jobId]);
    }
    
    /**
     * Update task last run timestamp
     */
    private function updateTaskLastRun($taskId)
    {
        $stmt = $this->database->prepare("
            UPDATE tasks 
            SET last_run = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        ");
        
        $stmt->execute([$taskId]);
    }
}

/**
 * HTTP API Controller
 */
class TaskAutomationController
{
    private $service;
    
    public function __construct()
    {
        $this->service = new TaskAutomationService();
    }
    
    public function healthAction()
    {
        return new JsonResponse([
            'status' => 'healthy',
            'service' => 'task-automation',
            'timestamp' => date('c')
        ]);
    }
    
    public function statusAction()
    {
        return new JsonResponse($this->service->getStatus());
    }
    
    public function getTasksAction()
    {
        return new JsonResponse($this->service->getTasks());
    }
    
    public function addTaskAction(Request $request)
    {
        $data = json_decode($request->getContent(), true);
        
        $result = $this->service->addTask(
            $data['name'] ?? '',
            $data['command'] ?? '',
            $data['schedule'] ?? null,
            $data['description'] ?? ''
        );
        
        return new JsonResponse($result);
    }
    
    public function executeTaskAction(Request $request, $taskId)
    {
        $result = $this->service->executeTask($taskId);
        return new JsonResponse($result);
    }
    
    public function startSchedulerAction()
    {
        // Start scheduler in background
        $command = "php -r \"
            require_once 'TaskAutomation.php';
            \$service = new DevToolkit\\TaskAutomation\\TaskAutomationService();
            \$service->startScheduler();
        \" > /dev/null 2>&1 &";
        
        exec($command);
        
        return new JsonResponse(['success' => true, 'message' => 'Scheduler started']);
    }
    
    public function createWorkflowAction(Request $request)
    {
        $data = json_decode($request->getContent(), true);
        
        $result = $this->service->createWorkflow(
            $data['name'] ?? '',
            $data['steps'] ?? [],
            $data['description'] ?? ''
        );
        
        return new JsonResponse($result);
    }
    
    public function executeWorkflowAction(Request $request, $workflowId)
    {
        $result = $this->service->executeWorkflow($workflowId);
        return new JsonResponse($result);
    }
    
    public function getHistoryAction(Request $request, $taskId = null)
    {
        $limit = $request->query->get('limit', 50);
        $history = $this->service->getTaskHistory($taskId, $limit);
        
        return new JsonResponse(['history' => $history]);
    }
}

// Bootstrap the application
if (php_sapi_name() !== 'cli') {
    // HTTP mode
    $routes = new RouteCollection();
    
    $routes->add('health', new Route('/health', ['_controller' => [new TaskAutomationController(), 'healthAction']]));
    $routes->add('status', new Route('/status', ['_controller' => [new TaskAutomationController(), 'statusAction']]));
    $routes->add('tasks', new Route('/tasks', ['_controller' => [new TaskAutomationController(), 'getTasksAction']], [], [], '', [], ['GET']));
    $routes->add('add_task', new Route('/tasks', ['_controller' => [new TaskAutomationController(), 'addTaskAction']], [], [], '', [], ['POST']));
    $routes->add('execute_task', new Route('/tasks/{taskId}/execute', ['_controller' => [new TaskAutomationController(), 'executeTaskAction']], [], [], '', [], ['POST']));
    $routes->add('start_scheduler', new Route('/scheduler/start', ['_controller' => [new TaskAutomationController(), 'startSchedulerAction']], [], [], '', [], ['POST']));
    $routes->add('create_workflow', new Route('/workflows', ['_controller' => [new TaskAutomationController(), 'createWorkflowAction']], [], [], '', [], ['POST']));
    $routes->add('execute_workflow', new Route('/workflows/{workflowId}/execute', ['_controller' => [new TaskAutomationController(), 'executeWorkflowAction']], [], [], '', [], ['POST']));
    $routes->add('history', new Route('/history/{taskId}', ['_controller' => [new TaskAutomationController(), 'getHistoryAction']], ['taskId' => '\d+'], [], '', [], ['GET']));
    $routes->add('history_all', new Route('/history', ['_controller' => [new TaskAutomationController(), 'getHistoryAction']], [], [], '', [], ['GET']));
    
    $context = new RequestContext();
    $matcher = new UrlMatcher($routes, $context);
    
    $controllerResolver = new ControllerResolver();
    $argumentResolver = new ArgumentResolver();
    
    $kernel = new HttpKernel($matcher, $controllerResolver, null, $argumentResolver);
    
    $request = Request::createFromGlobals();
    $response = $kernel->handle($request);
    $response->send();
    
} else {
    // CLI mode
    if ($argc > 1) {
        $service = new TaskAutomationService();
        
        switch ($argv[1]) {
            case 'start':
                echo "Starting task scheduler...\n";
                $service->startScheduler();
                break;
                
            case 'execute':
                if (isset($argv[2])) {
                    echo "Executing task {$argv[2]}...\n";
                    $result = $service->executeTask($argv[2]);
                    echo json_encode($result, JSON_PRETTY_PRINT) . "\n";
                } else {
                    echo "Usage: php TaskAutomation.php execute <task_id>\n";
                }
                break;
                
            case 'status':
                $status = $service->getStatus();
                echo json_encode($status, JSON_PRETTY_PRINT) . "\n";
                break;
                
            default:
                echo "Usage: php TaskAutomation.php [start|execute|status]\n";
        }
    } else {
        echo "Task Automation Service\n";
        echo "Usage: php TaskAutomation.php [start|execute|status]\n";
    }
}

?>
