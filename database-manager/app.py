from flask import Flask, request, jsonify
from flask_cors import CORS
from sqlalchemy import create_engine, text, inspect, MetaData, Table
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.declarative import declarative_base
import pymongo
import redis
import psycopg2
import mysql.connector
import sqlite3
import json
import os
import logging
from datetime import datetime
from typing import Dict, List, Any
import pandas as pd
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
CORS(app)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('logs/database_manager.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

Base = declarative_base()

class DatabaseManager:
    def __init__(self):
        self.connections = {}
        self.engines = {}
        self.sessions = {}
        
    def add_connection(self, name: str, connection_string: str, db_type: str):
        """Add a new database connection"""
        try:
            if db_type in ['postgresql', 'mysql', 'sqlite']:
                engine = create_engine(connection_string)
                Session = sessionmaker(bind=engine)
                self.engines[name] = engine
                self.sessions[name] = Session()
                self.connections[name] = {
                    'type': db_type,
                    'engine': engine,
                    'session': Session(),
                    'connection_string': connection_string
                }
            elif db_type == 'mongodb':
                client = pymongo.MongoClient(connection_string)
                self.connections[name] = {
                    'type': db_type,
                    'client': client,
                    'connection_string': connection_string
                }
            elif db_type == 'redis':
                client = redis.Redis.from_url(connection_string)
                self.connections[name] = {
                    'type': db_type,
                    'client': client,
                    'connection_string': connection_string
                }
            
            logger.info(f"Added {db_type} connection: {name}")
            return True
        except Exception as e:
            logger.error(f"Failed to add connection {name}: {str(e)}")
            return False
    
    def execute_query(self, connection_name: str, query: str, params: Dict = None):
        """Execute SQL query on specified connection"""
        try:
            if connection_name not in self.connections:
                raise ValueError(f"Connection {connection_name} not found")
            
            conn = self.connections[connection_name]
            
            if conn['type'] in ['postgresql', 'mysql', 'sqlite']:
                result = conn['session'].execute(text(query), params or {})
                
                if query.strip().upper().startswith('SELECT'):
                    columns = result.keys()
                    rows = result.fetchall()
                    return {
                        'columns': list(columns),
                        'rows': [dict(zip(columns, row)) for row in rows],
                        'row_count': len(rows)
                    }
                else:
                    conn['session'].commit()
                    return {'affected_rows': result.rowcount}
                    
        except Exception as e:
            logger.error(f"Query execution failed: {str(e)}")
            raise e
    
    def get_schema_info(self, connection_name: str):
        """Get database schema information"""
        try:
            conn = self.connections[connection_name]
            
            if conn['type'] in ['postgresql', 'mysql', 'sqlite']:
                inspector = inspect(conn['engine'])
                tables = inspector.get_table_names()
                
                schema = {}
                for table in tables:
                    columns = inspector.get_columns(table)
                    indexes = inspector.get_indexes(table)
                    foreign_keys = inspector.get_foreign_keys(table)
                    
                    schema[table] = {
                        'columns': columns,
                        'indexes': indexes,
                        'foreign_keys': foreign_keys
                    }
                
                return schema
                
        except Exception as e:
            logger.error(f"Schema inspection failed: {str(e)}")
            raise e
    
    def backup_database(self, connection_name: str, backup_path: str):
        """Create database backup"""
        try:
            conn = self.connections[connection_name]
            
            if conn['type'] == 'postgresql':
                os.system(f"pg_dump {conn['connection_string']} > {backup_path}")
            elif conn['type'] == 'mysql':
                os.system(f"mysqldump {conn['connection_string']} > {backup_path}")
            elif conn['type'] == 'sqlite':
                os.system(f"sqlite3 {conn['connection_string']} .dump > {backup_path}")
            
            logger.info(f"Backup created: {backup_path}")
            return True
            
        except Exception as e:
            logger.error(f"Backup failed: {str(e)}")
            return False

# Initialize database manager
db_manager = DatabaseManager()

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'connections': len(db_manager.connections)
    })

@app.route('/connections', methods=['GET'])
def list_connections():
    """List all database connections"""
    connections = {}
    for name, conn in db_manager.connections.items():
        connections[name] = {
            'type': conn['type'],
            'status': 'connected'
        }
    return jsonify(connections)

@app.route('/connections', methods=['POST'])
def add_connection():
    """Add new database connection"""
    data = request.json
    required_fields = ['name', 'connection_string', 'db_type']
    
    if not all(field in data for field in required_fields):
        return jsonify({'error': 'Missing required fields'}), 400
    
    success = db_manager.add_connection(
        data['name'],
        data['connection_string'],
        data['db_type']
    )
    
    if success:
        return jsonify({'message': 'Connection added successfully'})
    else:
        return jsonify({'error': 'Failed to add connection'}), 500

@app.route('/connections/<connection_name>', methods=['DELETE'])
def remove_connection(connection_name):
    """Remove database connection"""
    if connection_name in db_manager.connections:
        del db_manager.connections[connection_name]
        return jsonify({'message': 'Connection removed'})
    else:
        return jsonify({'error': 'Connection not found'}), 404

@app.route('/query/<connection_name>', methods=['POST'])
def execute_query(connection_name):
    """Execute SQL query"""
    data = request.json
    
    if 'query' not in data:
        return jsonify({'error': 'Query is required'}), 400
    
    try:
        result = db_manager.execute_query(
            connection_name,
            data['query'],
            data.get('params', {})
        )
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/schema/<connection_name>', methods=['GET'])
def get_schema(connection_name):
    """Get database schema information"""
    try:
        schema = db_manager.get_schema_info(connection_name)
        return jsonify(schema)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/backup/<connection_name>', methods=['POST'])
def backup_database(connection_name):
    """Create database backup"""
    data = request.json
    backup_path = data.get('backup_path', f'backups/{connection_name}_{datetime.now().strftime("%Y%m%d_%H%M%S")}.sql')
    
    try:
        success = db_manager.backup_database(connection_name, backup_path)
        if success:
            return jsonify({'message': 'Backup created', 'path': backup_path})
        else:
            return jsonify({'error': 'Backup failed'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/migrate/<connection_name>', methods=['POST'])
def run_migration():
    """Run database migration"""
    data = request.json
    migration_script = data.get('script', '')
    
    if not migration_script:
        return jsonify({'error': 'Migration script is required'}), 400
    
    try:
        result = db_manager.execute_query(connection_name, migration_script)
        return jsonify({'message': 'Migration completed', 'result': result})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/export/<connection_name>', methods=['POST'])
def export_data():
    """Export data to various formats"""
    data = request.json
    query = data.get('query', '')
    format_type = data.get('format', 'json')
    
    if not query:
        return jsonify({'error': 'Query is required'}), 400
    
    try:
        result = db_manager.execute_query(connection_name, query)
        
        if format_type == 'csv':
            df = pd.DataFrame(result['rows'])
            csv_data = df.to_csv(index=False)
            return csv_data, 200, {'Content-Type': 'text/csv'}
        elif format_type == 'excel':
            df = pd.DataFrame(result['rows'])
            excel_path = f'exports/export_{datetime.now().strftime("%Y%m%d_%H%M%S")}.xlsx'
            df.to_excel(excel_path, index=False)
            return jsonify({'message': 'Excel file created', 'path': excel_path})
        else:
            return jsonify(result)
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/performance/<connection_name>', methods=['GET'])
def get_performance_stats():
    """Get database performance statistics"""
    try:
        conn = db_manager.connections[connection_name]
        
        if conn['type'] == 'postgresql':
            stats_query = """
            SELECT 
                schemaname,
                tablename,
                n_tup_ins as inserts,
                n_tup_upd as updates,
                n_tup_del as deletes,
                n_live_tup as live_tuples,
                n_dead_tup as dead_tuples
            FROM pg_stat_user_tables;
            """
        elif conn['type'] == 'mysql':
            stats_query = """
            SELECT 
                TABLE_SCHEMA as schema_name,
                TABLE_NAME as table_name,
                TABLE_ROWS as row_count,
                DATA_LENGTH as data_size,
                INDEX_LENGTH as index_size
            FROM information_schema.TABLES 
            WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema');
            """
        else:
            return jsonify({'error': 'Performance stats not available for this database type'}), 400
        
        result = db_manager.execute_query(connection_name, stats_query)
        return jsonify(result)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# Error handlers
@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Endpoint not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    # Create necessary directories
    os.makedirs('logs', exist_ok=True)
    os.makedirs('backups', exist_ok=True)
    os.makedirs('exports', exist_ok=True)
    
    # Add default SQLite connection for testing
    db_manager.add_connection(
        'default_sqlite',
        'sqlite:///default.db',
        'sqlite'
    )
    
    app.run(host='0.0.0.0', port=5000, debug=True)
