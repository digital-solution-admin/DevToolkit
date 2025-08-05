use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use tokio::time::sleep;
use tokio::sync::{mpsc, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;
use csv::ReaderBuilder;
use reqwest::Client;
use futures::stream::{self, StreamExt};
use chrono::{DateTime, Utc};
use rayon::prelude::*;

use warp::{Filter, Rejection, Reply};
use warp::http::StatusCode;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataRecord {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub data: Value,
    pub source: String,
    pub processed: bool,
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingJob {
    pub id: String,
    pub name: String,
    pub status: JobStatus,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub input_count: usize,
    pub processed_count: usize,
    pub error_count: usize,
    pub configuration: ProcessingConfig,
    pub results: Vec<ProcessingResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum JobStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingConfig {
    pub operations: Vec<Operation>,
    pub batch_size: usize,
    pub parallel_workers: usize,
    pub timeout_seconds: u64,
    pub retry_attempts: u32,
    pub output_format: OutputFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Operation {
    Transform { field: String, expression: String },
    Filter { condition: String },
    Aggregate { group_by: Vec<String>, functions: Vec<AggregateFunction> },
    Join { source: String, on: String },
    Sort { fields: Vec<String>, ascending: bool },
    Deduplicate { fields: Vec<String> },
    Validate { rules: Vec<ValidationRule> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AggregateFunction {
    Count,
    Sum { field: String },
    Average { field: String },
    Min { field: String },
    Max { field: String },
    Custom { name: String, expression: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationRule {
    pub field: String,
    pub rule_type: ValidationType,
    pub parameters: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ValidationType {
    Required,
    DataType { expected_type: String },
    Range { min: f64, max: f64 },
    Length { min_length: usize, max_length: usize },
    Pattern { regex: String },
    Custom { expression: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OutputFormat {
    Json,
    Csv,
    Parquet,
    Database { connection_string: String, table: String },
    Api { endpoint: String, headers: HashMap<String, String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingResult {
    pub operation: String,
    pub records_processed: usize,
    pub execution_time_ms: u128,
    pub memory_used_bytes: usize,
    pub errors: Vec<ProcessingError>,
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingError {
    pub error_type: String,
    pub message: String,
    pub record_id: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub context: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMetrics {
    pub cpu_usage: f64,
    pub memory_usage: f64,
    pub disk_usage: f64,
    pub active_jobs: usize,
    pub total_records_processed: u64,
    pub average_processing_time_ms: f64,
    pub error_rate: f64,
    pub uptime_seconds: u64,
}

pub struct DataProcessor {
    jobs: Arc<RwLock<HashMap<String, ProcessingJob>>>,
    data_store: Arc<RwLock<HashMap<String, Vec<DataRecord>>>>,
    metrics: Arc<RwLock<SystemMetrics>>,
    job_sender: mpsc::UnboundedSender<ProcessingJob>,
    start_time: Instant,
}

impl DataProcessor {
    pub fn new() -> Self {
        let (job_sender, job_receiver) = mpsc::unbounded_channel();
        
        let processor = Self {
            jobs: Arc::new(RwLock::new(HashMap::new())),
            data_store: Arc::new(RwLock::new(HashMap::new())),
            metrics: Arc::new(RwLock::new(SystemMetrics {
                cpu_usage: 0.0,
                memory_usage: 0.0,
                disk_usage: 0.0,
                active_jobs: 0,
                total_records_processed: 0,
                average_processing_time_ms: 0.0,
                error_rate: 0.0,
                uptime_seconds: 0,
            })),
            job_sender,
            start_time: Instant::now(),
        };

        // Start background job processor
        let jobs_clone = processor.jobs.clone();
        let metrics_clone = processor.metrics.clone();
        let data_store_clone = processor.data_store.clone();
        
        tokio::spawn(async move {
            Self::job_processor(job_receiver, jobs_clone, metrics_clone, data_store_clone).await;
        });

        // Start metrics updater
        let metrics_clone = processor.metrics.clone();
        let start_time = processor.start_time;
        
        tokio::spawn(async move {
            Self::update_metrics(metrics_clone, start_time).await;
        });

        processor
    }

    pub async fn submit_job(&self, mut job: ProcessingJob) -> Result<String, String> {
        job.id = Uuid::new_v4().to_string();
        job.status = JobStatus::Pending;
        job.created_at = Utc::now();
        
        let job_id = job.id.clone();
        
        // Store job
        {
            let mut jobs = self.jobs.write().await;
            jobs.insert(job_id.clone(), job.clone());
        }
        
        // Send to processor
        self.job_sender.send(job).map_err(|e| e.to_string())?;
        
        println!("Job submitted: {}", job_id);
        Ok(job_id)
    }

    pub async fn get_job_status(&self, job_id: &str) -> Option<ProcessingJob> {
        let jobs = self.jobs.read().await;
        jobs.get(job_id).cloned()
    }

    pub async fn list_jobs(&self) -> Vec<ProcessingJob> {
        let jobs = self.jobs.read().await;
        jobs.values().cloned().collect()
    }

    pub async fn cancel_job(&self, job_id: &str) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            if matches!(job.status, JobStatus::Pending | JobStatus::Running) {
                job.status = JobStatus::Cancelled;
                println!("Job cancelled: {}", job_id);
                Ok(())
            } else {
                Err("Job cannot be cancelled in current status".to_string())
            }
        } else {
            Err("Job not found".to_string())
        }
    }

    pub async fn load_data_from_file(&self, source_id: &str, file_path: &str) -> Result<usize, String> {
        let path = Path::new(file_path);
        if !path.exists() {
            return Err("File not found".to_string());
        }

        let mut records = Vec::new();
        
        if file_path.ends_with(".csv") {
            // Load CSV data
            let file = File::open(path).map_err(|e| e.to_string())?;
            let mut reader = ReaderBuilder::new().has_headers(true).from_reader(file);
            
            for result in reader.records() {
                let record = result.map_err(|e| e.to_string())?;
                let mut data_map = serde_json::Map::new();
                
                for (i, field) in record.iter().enumerate() {
                    data_map.insert(format!("field_{}", i), Value::String(field.to_string()));
                }
                
                records.push(DataRecord {
                    id: Uuid::new_v4().to_string(),
                    timestamp: Utc::now(),
                    data: Value::Object(data_map),
                    source: source_id.to_string(),
                    processed: false,
                    metadata: HashMap::new(),
                });
            }
        } else if file_path.ends_with(".json") {
            // Load JSON data
            let file = File::open(path).map_err(|e| e.to_string())?;
            let reader = BufReader::new(file);
            
            for line in reader.lines() {
                let line = line.map_err(|e| e.to_string())?;
                if let Ok(data) = serde_json::from_str::<Value>(&line) {
                    records.push(DataRecord {
                        id: Uuid::new_v4().to_string(),
                        timestamp: Utc::now(),
                        data,
                        source: source_id.to_string(),
                        processed: false,
                        metadata: HashMap::new(),
                    });
                }
            }
        }

        let count = records.len();
        
        // Store data
        {
            let mut data_store = self.data_store.write().await;
            data_store.insert(source_id.to_string(), records);
        }

        println!("Loaded {} records from {}", count, file_path);
        Ok(count)
    }

    pub async fn load_data_from_api(&self, source_id: &str, endpoint: &str) -> Result<usize, String> {
        let client = Client::new();
        let response = client.get(endpoint).send().await.map_err(|e| e.to_string())?;
        
        if !response.status().is_success() {
            return Err(format!("API request failed: {}", response.status()));
        }

        let data: Value = response.json().await.map_err(|e| e.to_string())?;
        let mut records = Vec::new();

        // Handle different API response formats
        match data {
            Value::Array(items) => {
                for item in items {
                    records.push(DataRecord {
                        id: Uuid::new_v4().to_string(),
                        timestamp: Utc::now(),
                        data: item,
                        source: source_id.to_string(),
                        processed: false,
                        metadata: HashMap::new(),
                    });
                }
            },
            Value::Object(obj) => {
                if let Some(items) = obj.get("data").and_then(|v| v.as_array()) {
                    for item in items {
                        records.push(DataRecord {
                            id: Uuid::new_v4().to_string(),
                            timestamp: Utc::now(),
                            data: item.clone(),
                            source: source_id.to_string(),
                            processed: false,
                            metadata: HashMap::new(),
                        });
                    }
                } else {
                    records.push(DataRecord {
                        id: Uuid::new_v4().to_string(),
                        timestamp: Utc::now(),
                        data: Value::Object(obj),
                        source: source_id.to_string(),
                        processed: false,
                        metadata: HashMap::new(),
                    });
                }
            },
            _ => {
                records.push(DataRecord {
                    id: Uuid::new_v4().to_string(),
                    timestamp: Utc::now(),
                    data,
                    source: source_id.to_string(),
                    processed: false,
                    metadata: HashMap::new(),
                });
            }
        }

        let count = records.len();
        
        // Store data
        {
            let mut data_store = self.data_store.write().await;
            data_store.insert(source_id.to_string(), records);
        }

        println!("Loaded {} records from API {}", count, endpoint);
        Ok(count)
    }

    pub async fn get_metrics(&self) -> SystemMetrics {
        self.metrics.read().await.clone()
    }

    async fn job_processor(
        mut receiver: mpsc::UnboundedReceiver<ProcessingJob>,
        jobs: Arc<RwLock<HashMap<String, ProcessingJob>>>,
        metrics: Arc<RwLock<SystemMetrics>>,
        data_store: Arc<RwLock<HashMap<String, Vec<DataRecord>>>>,
    ) {
        while let Some(mut job) = receiver.recv().await {
            println!("Processing job: {}", job.id);
            
            // Update job status
            job.status = JobStatus::Running;
            job.started_at = Some(Utc::now());
            
            {
                let mut jobs_map = jobs.write().await;
                jobs_map.insert(job.id.clone(), job.clone());
            }

            // Process job
            let start_time = Instant::now();
            let result = Self::execute_processing_job(&job, &data_store).await;
            let execution_time = start_time.elapsed();

            // Update job with results
            match result {
                Ok(results) => {
                    job.status = JobStatus::Completed;
                    job.completed_at = Some(Utc::now());
                    job.results = results;
                    job.processed_count = job.input_count; // Simplified
                    println!("Job completed: {} in {:?}", job.id, execution_time);
                },
                Err(error) => {
                    job.status = JobStatus::Failed;
                    job.completed_at = Some(Utc::now());
                    job.error_count += 1;
                    println!("Job failed: {} - {}", job.id, error);
                }
            }

            // Update stored job
            {
                let mut jobs_map = jobs.write().await;
                jobs_map.insert(job.id.clone(), job);
            }

            // Update metrics
            {
                let mut metrics_guard = metrics.write().await;
                metrics_guard.total_records_processed += job.processed_count as u64;
                metrics_guard.average_processing_time_ms = execution_time.as_millis() as f64;
            }
        }
    }

    async fn execute_processing_job(
        job: &ProcessingJob,
        data_store: &Arc<RwLock<HashMap<String, Vec<DataRecord>>>>,
    ) -> Result<Vec<ProcessingResult>, String> {
        let mut results = Vec::new();
        
        // Get input data (simplified - assumes single source)
        let data = {
            let store = data_store.read().await;
            store.values().next().cloned().unwrap_or_default()
        };

        if data.is_empty() {
            return Err("No input data available".to_string());
        }

        let mut current_data = data;
        
        // Execute operations sequentially
        for operation in &job.configuration.operations {
            let start_time = Instant::now();
            let operation_name = format!("{:?}", operation);
            
            current_data = Self::execute_operation(operation, current_data).await?;
            
            let execution_time = start_time.elapsed();
            
            results.push(ProcessingResult {
                operation: operation_name,
                records_processed: current_data.len(),
                execution_time_ms: execution_time.as_millis(),
                memory_used_bytes: std::mem::size_of_val(&current_data),
                errors: Vec::new(),
                metadata: HashMap::new(),
            });
        }

        // Output results based on configuration
        Self::output_results(&current_data, &job.configuration.output_format).await?;

        Ok(results)
    }

    async fn execute_operation(
        operation: &Operation,
        mut data: Vec<DataRecord>,
    ) -> Result<Vec<DataRecord>, String> {
        match operation {
            Operation::Filter { condition } => {
                // Simplified filter implementation
                data.retain(|record| {
                    // In a real implementation, you'd parse and evaluate the condition
                    true // Placeholder
                });
                Ok(data)
            },
            Operation::Transform { field, expression } => {
                // Parallel transformation using rayon
                data.par_iter_mut().for_each(|record| {
                    // In a real implementation, you'd parse and evaluate the expression
                    if let Some(field_value) = record.data.get_mut(field) {
                        // Placeholder transformation
                        *field_value = json!(format!("transformed_{}", field_value));
                    }
                });
                Ok(data)
            },
            Operation::Sort { fields, ascending } => {
                data.sort_by(|a, b| {
                    // Simplified sorting by first field
                    if let Some(field) = fields.first() {
                        let a_val = a.data.get(field).unwrap_or(&Value::Null);
                        let b_val = b.data.get(field).unwrap_or(&Value::Null);
                        
                        if *ascending {
                            a_val.to_string().cmp(&b_val.to_string())
                        } else {
                            b_val.to_string().cmp(&a_val.to_string())
                        }
                    } else {
                        std::cmp::Ordering::Equal
                    }
                });
                Ok(data)
            },
            Operation::Deduplicate { fields } => {
                let mut seen = std::collections::HashSet::new();
                data.retain(|record| {
                    let key: Vec<String> = fields.iter()
                        .map(|field| record.data.get(field).unwrap_or(&Value::Null).to_string())
                        .collect();
                    seen.insert(key)
                });
                Ok(data)
            },
            Operation::Validate { rules } => {
                for record in &mut data {
                    for rule in rules {
                        if let Err(error) = Self::validate_record(record, rule) {
                            // In a real implementation, you'd collect validation errors
                            println!("Validation error for record {}: {}", record.id, error);
                        }
                    }
                }
                Ok(data)
            },
            _ => {
                // Placeholder for other operations
                Ok(data)
            }
        }
    }

    fn validate_record(record: &DataRecord, rule: &ValidationRule) -> Result<(), String> {
        let field_value = record.data.get(&rule.field);
        
        match &rule.rule_type {
            ValidationType::Required => {
                if field_value.is_none() || field_value == Some(&Value::Null) {
                    return Err(format!("Field {} is required", rule.field));
                }
            },
            ValidationType::DataType { expected_type } => {
                if let Some(value) = field_value {
                    let actual_type = match value {
                        Value::String(_) => "string",
                        Value::Number(_) => "number",
                        Value::Bool(_) => "boolean",
                        Value::Array(_) => "array",
                        Value::Object(_) => "object",
                        Value::Null => "null",
                    };
                    
                    if actual_type != expected_type {
                        return Err(format!("Field {} expected type {}, got {}", 
                                         rule.field, expected_type, actual_type));
                    }
                }
            },
            ValidationType::Range { min, max } => {
                if let Some(Value::Number(num)) = field_value {
                    if let Some(val) = num.as_f64() {
                        if val < *min || val > *max {
                            return Err(format!("Field {} value {} out of range [{}, {}]", 
                                             rule.field, val, min, max));
                        }
                    }
                }
            },
            _ => {
                // Placeholder for other validation types
            }
        }
        
        Ok(())
    }

    async fn output_results(
        data: &[DataRecord],
        output_format: &OutputFormat,
    ) -> Result<(), String> {
        match output_format {
            OutputFormat::Json => {
                let json_output = serde_json::to_string_pretty(data)
                    .map_err(|e| e.to_string())?;
                
                let mut file = std::fs::File::create("output.json")
                    .map_err(|e| e.to_string())?;
                file.write_all(json_output.as_bytes())
                    .map_err(|e| e.to_string())?;
                
                println!("Results written to output.json");
            },
            OutputFormat::Csv => {
                let mut wtr = csv::Writer::from_path("output.csv")
                    .map_err(|e| e.to_string())?;
                
                // Write headers (simplified)
                wtr.write_record(&["id", "timestamp", "source", "data"])
                    .map_err(|e| e.to_string())?;
                
                for record in data {
                    wtr.write_record(&[
                        &record.id,
                        &record.timestamp.to_rfc3339(),
                        &record.source,
                        &record.data.to_string(),
                    ]).map_err(|e| e.to_string())?;
                }
                
                wtr.flush().map_err(|e| e.to_string())?;
                println!("Results written to output.csv");
            },
            OutputFormat::Api { endpoint, headers } => {
                let client = Client::new();
                let mut request = client.post(endpoint);
                
                for (key, value) in headers {
                    request = request.header(key, value);
                }
                
                let response = request.json(data).send().await
                    .map_err(|e| e.to_string())?;
                
                if response.status().is_success() {
                    println!("Results sent to API endpoint: {}", endpoint);
                } else {
                    return Err(format!("API request failed: {}", response.status()));
                }
            },
            _ => {
                println!("Output format not implemented yet");
            }
        }
        
        Ok(())
    }

    async fn update_metrics(metrics: Arc<RwLock<SystemMetrics>>, start_time: Instant) {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        
        loop {
            interval.tick().await;
            
            let mut metrics_guard = metrics.write().await;
            metrics_guard.uptime_seconds = start_time.elapsed().as_secs();
            
            // In a real implementation, you'd collect actual system metrics
            metrics_guard.cpu_usage = rand::random::<f64>() * 100.0;
            metrics_guard.memory_usage = rand::random::<f64>() * 100.0;
            metrics_guard.disk_usage = rand::random::<f64>() * 100.0;
        }
    }
}

// REST API handlers
pub async fn health_handler() -> Result<impl Reply, Rejection> {
    let health = json!({
        "status": "healthy",
        "service": "rust-data-processor",
        "timestamp": Utc::now(),
        "version": "1.0.0"
    });
    
    Ok(warp::reply::with_status(
        warp::reply::json(&health),
        StatusCode::OK,
    ))
}

pub async fn submit_job_handler(
    job: ProcessingJob,
    processor: Arc<DataProcessor>,
) -> Result<impl Reply, Rejection> {
    match processor.submit_job(job).await {
        Ok(job_id) => {
            let response = json!({
                "success": true,
                "job_id": job_id,
                "message": "Job submitted successfully"
            });
            Ok(warp::reply::with_status(
                warp::reply::json(&response),
                StatusCode::CREATED,
            ))
        },
        Err(error) => {
            let response = json!({
                "success": false,
                "error": error
            });
            Ok(warp::reply::with_status(
                warp::reply::json(&response),
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    }
}

pub async fn get_job_handler(
    job_id: String,
    processor: Arc<DataProcessor>,
) -> Result<impl Reply, Rejection> {
    match processor.get_job_status(&job_id).await {
        Some(job) => Ok(warp::reply::with_status(
            warp::reply::json(&job),
            StatusCode::OK,
        )),
        None => {
            let response = json!({
                "error": "Job not found"
            });
            Ok(warp::reply::with_status(
                warp::reply::json(&response),
                StatusCode::NOT_FOUND,
            ))
        }
    }
}

pub async fn list_jobs_handler(
    processor: Arc<DataProcessor>,
) -> Result<impl Reply, Rejection> {
    let jobs = processor.list_jobs().await;
    Ok(warp::reply::with_status(
        warp::reply::json(&jobs),
        StatusCode::OK,
    ))
}

pub async fn metrics_handler(
    processor: Arc<DataProcessor>,
) -> Result<impl Reply, Rejection> {
    let metrics = processor.get_metrics().await;
    Ok(warp::reply::with_status(
        warp::reply::json(&metrics),
        StatusCode::OK,
    ))
}

#[tokio::main]
async fn main() {
    // Initialize processor
    let processor = Arc::new(DataProcessor::new());
    
    // Load sample data
    if let Err(e) = processor.load_data_from_file("sample", "data/sample.csv").await {
        println!("Warning: Could not load sample data: {}", e);
    }

    // Setup API routes
    let health = warp::path("health")
        .and(warp::get())
        .and_then(health_handler);

    let submit_job = warp::path("jobs")
        .and(warp::post())
        .and(warp::body::json())
        .and(warp::any().map(move || processor.clone()))
        .and_then(submit_job_handler);

    let get_job = warp::path!("jobs" / String)
        .and(warp::get())
        .and(warp::any().map(move || processor.clone()))
        .and_then(get_job_handler);

    let list_jobs = warp::path("jobs")
        .and(warp::get())
        .and(warp::any().map(move || processor.clone()))
        .and_then(list_jobs_handler);

    let metrics = warp::path("metrics")
        .and(warp::get())
        .and(warp::any().map(move || processor.clone()))
        .and_then(metrics_handler);

    let routes = health
        .or(submit_job)
        .or(get_job)
        .or(list_jobs)
        .or(metrics)
        .with(warp::cors().allow_any_origin().allow_any_method().allow_any_header());

    println!("Rust Data Processor starting on http://localhost:8000");
    
    warp::serve(routes)
        .run(([0, 0, 0, 0], 8000))
        .await;
}
