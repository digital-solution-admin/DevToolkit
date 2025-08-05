package com.devtoolkit;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpStatus;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@SpringBootApplication
@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "*")
public class CodeGeneratorApplication {

    private static final Logger logger = LoggerFactory.getLogger(CodeGeneratorApplication.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Map<String, CodeTemplate> templates = new ConcurrentHashMap<>();

    public static void main(String[] args) {
        SpringApplication.run(CodeGeneratorApplication.class, args);
    }

    @PostConstruct
    public void initializeTemplates() {
        loadDefaultTemplates();
        logger.info("Code Generator initialized with {} templates", templates.size());
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> healthCheck() {
        Map<String, Object> health = new HashMap<>();
        health.put("status", "healthy");
        health.put("timestamp", LocalDateTime.now().toString());
        health.put("templates", templates.size());
        health.put("version", "1.0.0");
        return ResponseEntity.ok(health);
    }

    @GetMapping("/templates")
    public ResponseEntity<Map<String, CodeTemplate>> getTemplates() {
        return ResponseEntity.ok(templates);
    }

    @PostMapping("/generate")
    public ResponseEntity<Map<String, Object>> generateCode(@RequestBody GenerationRequest request) {
        try {
            logger.info("Generating code for template: {}", request.getTemplateName());
            
            if (!templates.containsKey(request.getTemplateName())) {
                return ResponseEntity.badRequest()
                    .body(Map.of("error", "Template not found: " + request.getTemplateName()));
            }

            CodeTemplate template = templates.get(request.getTemplateName());
            String generatedCode = processTemplate(template, request.getParameters());
            
            Map<String, Object> response = new HashMap<>();
            response.put("template", request.getTemplateName());
            response.put("generated_code", generatedCode);
            response.put("timestamp", LocalDateTime.now().toString());
            response.put("parameters", request.getParameters());

            // Save to file if requested
            if (request.getOutputPath() != null && !request.getOutputPath().isEmpty()) {
                saveGeneratedCode(generatedCode, request.getOutputPath());
                response.put("saved_to", request.getOutputPath());
            }

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            logger.error("Code generation failed", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/templates")
    public ResponseEntity<Map<String, String>> addTemplate(@RequestBody CodeTemplate template) {
        try {
            templates.put(template.getName(), template);
            logger.info("Added new template: {}", template.getName());
            return ResponseEntity.ok(Map.of("message", "Template added successfully"));
        } catch (Exception e) {
            logger.error("Failed to add template", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/generate/crud")
    public ResponseEntity<Map<String, Object>> generateCrud(@RequestBody CrudRequest request) {
        try {
            Map<String, String> generatedFiles = new HashMap<>();
            
            // Generate Entity
            String entity = generateEntity(request);
            generatedFiles.put("Entity.java", entity);
            
            // Generate Repository
            String repository = generateRepository(request);
            generatedFiles.put("Repository.java", repository);
            
            // Generate Service
            String service = generateService(request);
            generatedFiles.put("Service.java", service);
            
            // Generate Controller
            String controller = generateController(request);
            generatedFiles.put("Controller.java", controller);
            
            // Generate Tests
            String tests = generateTests(request);
            generatedFiles.put("Tests.java", tests);

            Map<String, Object> response = new HashMap<>();
            response.put("entity", request.getEntityName());
            response.put("files", generatedFiles);
            response.put("timestamp", LocalDateTime.now().toString());

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            logger.error("CRUD generation failed", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/generate/api")
    public ResponseEntity<Map<String, Object>> generateApi(@RequestBody ApiRequest request) {
        try {
            Map<String, String> apiFiles = new HashMap<>();
            
            switch (request.getFramework().toLowerCase()) {
                case "express":
                    apiFiles = generateExpressApi(request);
                    break;
                case "flask":
                    apiFiles = generateFlaskApi(request);
                    break;
                case "spring":
                    apiFiles = generateSpringApi(request);
                    break;
                case "fastapi":
                    apiFiles = generateFastApi(request);
                    break;
                default:
                    return ResponseEntity.badRequest()
                        .body(Map.of("error", "Unsupported framework: " + request.getFramework()));
            }

            Map<String, Object> response = new HashMap<>();
            response.put("framework", request.getFramework());
            response.put("files", apiFiles);
            response.put("endpoints", request.getEndpoints().size());
            response.put("timestamp", LocalDateTime.now().toString());

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            logger.error("API generation failed", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/generate/database")
    public ResponseEntity<Map<String, Object>> generateDatabase(@RequestBody DatabaseRequest request) {
        try {
            Map<String, String> dbFiles = new HashMap<>();
            
            // Generate migrations
            String migration = generateMigration(request);
            dbFiles.put("migration.sql", migration);
            
            // Generate seeds
            String seeds = generateSeeds(request);
            dbFiles.put("seeds.sql", seeds);
            
            // Generate models based on language
            if (request.getLanguage() != null) {
                switch (request.getLanguage().toLowerCase()) {
                    case "python":
                        dbFiles.put("models.py", generatePythonModels(request));
                        break;
                    case "javascript":
                        dbFiles.put("models.js", generateJSModels(request));
                        break;
                    case "java":
                        dbFiles.put("Models.java", generateJavaModels(request));
                        break;
                    case "php":
                        dbFiles.put("Models.php", generatePHPModels(request));
                        break;
                }
            }

            Map<String, Object> response = new HashMap<>();
            response.put("database", request.getDatabaseName());
            response.put("tables", request.getTables().size());
            response.put("files", dbFiles);
            response.put("timestamp", LocalDateTime.now().toString());

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            logger.error("Database generation failed", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("error", e.getMessage()));
        }
    }

    private void loadDefaultTemplates() {
        // REST Controller Template
        templates.put("rest-controller", new CodeTemplate(
            "rest-controller",
            "Spring Boot REST Controller",
            "java",
            getRestControllerTemplate()
        ));

        // React Component Template
        templates.put("react-component", new CodeTemplate(
            "react-component",
            "React Functional Component",
            "javascript",
            getReactComponentTemplate()
        ));

        // Python Class Template
        templates.put("python-class", new CodeTemplate(
            "python-class",
            "Python Class with methods",
            "python",
            getPythonClassTemplate()
        ));

        // PHP Class Template
        templates.put("php-class", new CodeTemplate(
            "php-class",
            "PHP Class with methods",
            "php",
            getPHPClassTemplate()
        ));

        // C++ Class Template
        templates.put("cpp-class", new CodeTemplate(
            "cpp-class",
            "C++ Class with header",
            "cpp",
            getCppClassTemplate()
        ));
    }

    private String processTemplate(CodeTemplate template, Map<String, String> parameters) {
        String content = template.getContent();
        
        for (Map.Entry<String, String> param : parameters.entrySet()) {
            content = content.replace("{{" + param.getKey() + "}}", param.getValue());
        }
        
        // Add timestamp
        content = content.replace("{{TIMESTAMP}}", LocalDateTime.now().toString());
        
        return content;
    }

    private void saveGeneratedCode(String code, String outputPath) throws IOException {
        Path path = Paths.get(outputPath);
        Files.createDirectories(path.getParent());
        Files.write(path, code.getBytes());
        logger.info("Saved generated code to: {}", outputPath);
    }

    // Template content methods
    private String getRestControllerTemplate() {
        return """
            package {{PACKAGE}};
            
            import org.springframework.web.bind.annotation.*;
            import org.springframework.http.ResponseEntity;
            import java.util.*;
            
            /**
             * {{DESCRIPTION}}
             * Generated on: {{TIMESTAMP}}
             */
            @RestController
            @RequestMapping("/api/{{ENDPOINT}}")
            @CrossOrigin(origins = "*")
            public class {{CLASS_NAME}}Controller {
            
                @GetMapping
                public ResponseEntity<List<{{ENTITY}}>> getAll() {
                    // TODO: Implement get all {{ENTITY}} logic
                    return ResponseEntity.ok(new ArrayList<>());
                }
                
                @GetMapping("/{id}")
                public ResponseEntity<{{ENTITY}}> getById(@PathVariable Long id) {
                    // TODO: Implement get {{ENTITY}} by id logic
                    return ResponseEntity.ok(new {{ENTITY}}());
                }
                
                @PostMapping
                public ResponseEntity<{{ENTITY}}> create(@RequestBody {{ENTITY}} entity) {
                    // TODO: Implement create {{ENTITY}} logic
                    return ResponseEntity.ok(entity);
                }
                
                @PutMapping("/{id}")
                public ResponseEntity<{{ENTITY}}> update(@PathVariable Long id, @RequestBody {{ENTITY}} entity) {
                    // TODO: Implement update {{ENTITY}} logic
                    return ResponseEntity.ok(entity);
                }
                
                @DeleteMapping("/{id}")
                public ResponseEntity<Void> delete(@PathVariable Long id) {
                    // TODO: Implement delete {{ENTITY}} logic
                    return ResponseEntity.ok().build();
                }
            }
            """;
    }

    private String getReactComponentTemplate() {
        return """
            import React, { useState, useEffect } from 'react';
            import './{{COMPONENT_NAME}}.css';
            
            /**
             * {{DESCRIPTION}}
             * Generated on: {{TIMESTAMP}}
             */
            const {{COMPONENT_NAME}} = ({{PROPS}}) => {
              const [{{STATE_NAME}}, set{{STATE_NAME_CAPITALIZED}}] = useState({{INITIAL_VALUE}});
            
              useEffect(() => {
                // TODO: Add component logic here
              }, []);
            
              const handle{{ACTION}} = () => {
                // TODO: Implement {{ACTION}} handler
              };
            
              return (
                <div className="{{CSS_CLASS}}">
                  <h2>{{TITLE}}</h2>
                  {/* TODO: Add component JSX here */}
                </div>
              );
            };
            
            export default {{COMPONENT_NAME}};
            """;
    }

    private String getPythonClassTemplate() {
        return """
            \"\"\"
            {{DESCRIPTION}}
            Generated on: {{TIMESTAMP}}
            \"\"\"
            
            class {{CLASS_NAME}}:
                def __init__(self{{INIT_PARAMS}}):
                    \"\"\"Initialize {{CLASS_NAME}}\"\"\"
                    {{INIT_BODY}}
                
                def {{METHOD_NAME}}(self{{METHOD_PARAMS}}):
                    \"\"\"{{METHOD_DESCRIPTION}}\"\"\"
                    # TODO: Implement {{METHOD_NAME}} logic
                    pass
                
                def __str__(self):
                    return f"{{CLASS_NAME}}({{STR_FORMAT}})"
                
                def __repr__(self):
                    return self.__str__()
            """;
    }

    private String getPHPClassTemplate() {
        return """
            <?php
            
            /**
             * {{DESCRIPTION}}
             * Generated on: {{TIMESTAMP}}
             */
            class {{CLASS_NAME}} {
                {{PROPERTIES}}
                
                public function __construct({{CONSTRUCTOR_PARAMS}}) {
                    {{CONSTRUCTOR_BODY}}
                }
                
                public function {{METHOD_NAME}}({{METHOD_PARAMS}}) {
                    // TODO: Implement {{METHOD_NAME}} logic
                }
                
                public function toArray() {
                    return [
                        {{TO_ARRAY_BODY}}
                    ];
                }
                
                public function __toString() {
                    return json_encode($this->toArray());
                }
            }
            """;
    }

    private String getCppClassTemplate() {
        return """
            #ifndef {{HEADER_GUARD}}
            #define {{HEADER_GUARD}}
            
            #include <iostream>
            #include <string>
            #include <vector>
            
            /**
             * {{DESCRIPTION}}
             * Generated on: {{TIMESTAMP}}
             */
            class {{CLASS_NAME}} {
            private:
                {{PRIVATE_MEMBERS}}
            
            public:
                // Constructor
                {{CLASS_NAME}}({{CONSTRUCTOR_PARAMS}});
                
                // Destructor
                ~{{CLASS_NAME}}();
                
                // Copy constructor
                {{CLASS_NAME}}(const {{CLASS_NAME}}& other);
                
                // Assignment operator
                {{CLASS_NAME}}& operator=(const {{CLASS_NAME}}& other);
                
                // Methods
                {{METHOD_SIGNATURES}}
                
                // Getters and Setters
                {{GETTERS_SETTERS}}
            };
            
            #endif // {{HEADER_GUARD}}
            """;
    }

    // Generation methods for different components
    private String generateEntity(CrudRequest request) {
        StringBuilder entity = new StringBuilder();
        entity.append("package ").append(request.getPackageName()).append(".entity;\n\n");
        entity.append("import javax.persistence.*;\n");
        entity.append("import java.time.LocalDateTime;\n\n");
        entity.append("@Entity\n");
        entity.append("@Table(name = \"").append(request.getTableName()).append("\")\n");
        entity.append("public class ").append(request.getEntityName()).append(" {\n\n");
        
        entity.append("    @Id\n");
        entity.append("    @GeneratedValue(strategy = GenerationType.IDENTITY)\n");
        entity.append("    private Long id;\n\n");
        
        for (Field field : request.getFields()) {
            entity.append("    @Column(name = \"").append(field.getName()).append("\")\n");
            entity.append("    private ").append(field.getType()).append(" ").append(field.getName()).append(";\n\n");
        }
        
        entity.append("    // Constructors, getters, and setters\n");
        entity.append("    // TODO: Generate constructors, getters, and setters\n");
        entity.append("}\n");
        
        return entity.toString();
    }

    private String generateRepository(CrudRequest request) {
        return String.format("""
            package %s.repository;
            
            import org.springframework.data.jpa.repository.JpaRepository;
            import org.springframework.stereotype.Repository;
            import %s.entity.%s;
            
            @Repository
            public interface %sRepository extends JpaRepository<%s, Long> {
                // Custom query methods can be added here
            }
            """, request.getPackageName(), request.getPackageName(), 
            request.getEntityName(), request.getEntityName(), request.getEntityName());
    }

    private String generateService(CrudRequest request) {
        return String.format("""
            package %s.service;
            
            import org.springframework.beans.factory.annotation.Autowired;
            import org.springframework.stereotype.Service;
            import %s.entity.%s;
            import %s.repository.%sRepository;
            import java.util.List;
            import java.util.Optional;
            
            @Service
            public class %sService {
            
                @Autowired
                private %sRepository repository;
                
                public List<%s> findAll() {
                    return repository.findAll();
                }
                
                public Optional<%s> findById(Long id) {
                    return repository.findById(id);
                }
                
                public %s save(%s entity) {
                    return repository.save(entity);
                }
                
                public void deleteById(Long id) {
                    repository.deleteById(id);
                }
            }
            """, request.getPackageName(), request.getPackageName(), request.getEntityName(),
            request.getPackageName(), request.getEntityName(), request.getEntityName(),
            request.getEntityName(), request.getEntityName(), request.getEntityName(),
            request.getEntityName(), request.getEntityName());
    }

    private String generateController(CrudRequest request) {
        return String.format("""
            package %s.controller;
            
            import org.springframework.beans.factory.annotation.Autowired;
            import org.springframework.http.ResponseEntity;
            import org.springframework.web.bind.annotation.*;
            import %s.entity.%s;
            import %s.service.%sService;
            import java.util.List;
            
            @RestController
            @RequestMapping("/api/%s")
            @CrossOrigin(origins = "*")
            public class %sController {
            
                @Autowired
                private %sService service;
                
                @GetMapping
                public ResponseEntity<List<%s>> getAll() {
                    return ResponseEntity.ok(service.findAll());
                }
                
                @GetMapping("/{id}")
                public ResponseEntity<%s> getById(@PathVariable Long id) {
                    return service.findById(id)
                        .map(ResponseEntity::ok)
                        .orElse(ResponseEntity.notFound().build());
                }
                
                @PostMapping
                public ResponseEntity<%s> create(@RequestBody %s entity) {
                    return ResponseEntity.ok(service.save(entity));
                }
                
                @PutMapping("/{id}")
                public ResponseEntity<%s> update(@PathVariable Long id, @RequestBody %s entity) {
                    return service.findById(id)
                        .map(existing -> ResponseEntity.ok(service.save(entity)))
                        .orElse(ResponseEntity.notFound().build());
                }
                
                @DeleteMapping("/{id}")
                public ResponseEntity<Void> delete(@PathVariable Long id) {
                    service.deleteById(id);
                    return ResponseEntity.ok().build();
                }
            }
            """, request.getPackageName(), request.getPackageName(), request.getEntityName(),
            request.getPackageName(), request.getEntityName(), request.getTableName().toLowerCase(),
            request.getEntityName(), request.getEntityName(), request.getEntityName(),
            request.getEntityName(), request.getEntityName(), request.getEntityName(),
            request.getEntityName(), request.getEntityName());
    }

    private String generateTests(CrudRequest request) {
        return String.format("""
            package %s.controller;
            
            import org.junit.jupiter.api.Test;
            import org.springframework.boot.test.context.SpringBootTest;
            import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
            import static org.junit.jupiter.api.Assertions.*;
            
            @SpringBootTest
            @SpringJUnitConfig
            public class %sControllerTest {
            
                @Test
                public void testGetAll() {
                    // TODO: Implement test for getAll
                }
                
                @Test
                public void testGetById() {
                    // TODO: Implement test for getById
                }
                
                @Test
                public void testCreate() {
                    // TODO: Implement test for create
                }
                
                @Test
                public void testUpdate() {
                    // TODO: Implement test for update
                }
                
                @Test
                public void testDelete() {
                    // TODO: Implement test for delete
                }
            }
            """, request.getPackageName(), request.getEntityName());
    }

    // Data classes
    public static class CodeTemplate {
        private String name;
        private String description;
        private String language;
        private String content;

        public CodeTemplate() {}

        public CodeTemplate(String name, String description, String language, String content) {
            this.name = name;
            this.description = description;
            this.language = language;
            this.content = content;
        }

        // Getters and setters
        public String getName() { return name; }
        public void setName(String name) { this.name = name; }
        public String getDescription() { return description; }
        public void setDescription(String description) { this.description = description; }
        public String getLanguage() { return language; }
        public void setLanguage(String language) { this.language = language; }
        public String getContent() { return content; }
        public void setContent(String content) { this.content = content; }
    }

    public static class GenerationRequest {
        private String templateName;
        private Map<String, String> parameters;
        private String outputPath;

        // Getters and setters
        public String getTemplateName() { return templateName; }
        public void setTemplateName(String templateName) { this.templateName = templateName; }
        public Map<String, String> getParameters() { return parameters; }
        public void setParameters(Map<String, String> parameters) { this.parameters = parameters; }
        public String getOutputPath() { return outputPath; }
        public void setOutputPath(String outputPath) { this.outputPath = outputPath; }
    }

    public static class CrudRequest {
        private String entityName;
        private String tableName;
        private String packageName;
        private List<Field> fields;

        // Getters and setters
        public String getEntityName() { return entityName; }
        public void setEntityName(String entityName) { this.entityName = entityName; }
        public String getTableName() { return tableName; }
        public void setTableName(String tableName) { this.tableName = tableName; }
        public String getPackageName() { return packageName; }
        public void setPackageName(String packageName) { this.packageName = packageName; }
        public List<Field> getFields() { return fields; }
        public void setFields(List<Field> fields) { this.fields = fields; }
    }

    public static class Field {
        private String name;
        private String type;
        private boolean nullable;

        // Getters and setters
        public String getName() { return name; }
        public void setName(String name) { this.name = name; }
        public String getType() { return type; }
        public void setType(String type) { this.type = type; }
        public boolean isNullable() { return nullable; }
        public void setNullable(boolean nullable) { this.nullable = nullable; }
    }

    public static class ApiRequest {
        private String framework;
        private List<Endpoint> endpoints;
        private String packageName;

        // Getters and setters
        public String getFramework() { return framework; }
        public void setFramework(String framework) { this.framework = framework; }
        public List<Endpoint> getEndpoints() { return endpoints; }
        public void setEndpoints(List<Endpoint> endpoints) { this.endpoints = endpoints; }
        public String getPackageName() { return packageName; }
        public void setPackageName(String packageName) { this.packageName = packageName; }
    }

    public static class Endpoint {
        private String path;
        private String method;
        private String description;

        // Getters and setters
        public String getPath() { return path; }
        public void setPath(String path) { this.path = path; }
        public String getMethod() { return method; }
        public void setMethod(String method) { this.method = method; }
        public String getDescription() { return description; }
        public void setDescription(String description) { this.description = description; }
    }

    public static class DatabaseRequest {
        private String databaseName;
        private String language;
        private List<Table> tables;

        // Getters and setters
        public String getDatabaseName() { return databaseName; }
        public void setDatabaseName(String databaseName) { this.databaseName = databaseName; }
        public String getLanguage() { return language; }
        public void setLanguage(String language) { this.language = language; }
        public List<Table> getTables() { return tables; }
        public void setTables(List<Table> tables) { this.tables = tables; }
    }

    public static class Table {
        private String name;
        private List<Field> fields;

        // Getters and setters
        public String getName() { return name; }
        public void setName(String name) { this.name = name; }
        public List<Field> getFields() { return fields; }
        public void setFields(List<Field> fields) { this.fields = fields; }
    }
}
