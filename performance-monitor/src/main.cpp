#include <iostream>
#include <string>
#include <vector>
#include <map>
#include <chrono>
#include <thread>
#include <fstream>
#include <sstream>
#include <memory>
#include <mutex>
#include <atomic>
#include <queue>
#include <algorithm>
#include <iomanip>

#ifdef _WIN32
    #include <windows.h>
    #include <psapi.h>
    #include <pdh.h>
    #pragma comment(lib, "pdh.lib")
#else
    #include <sys/sysinfo.h>
    #include <sys/types.h>
    #include <sys/stat.h>
    #include <unistd.h>
    #include <dirent.h>
#endif

#include "performance_monitor.h"
#include "web_server.h"
#include "logger.h"

class SystemMetrics {
private:
    std::atomic<bool> monitoring{false};
    std::thread monitoring_thread;
    std::mutex data_mutex;
    std::queue<MetricSnapshot> metric_history;
    static const size_t MAX_HISTORY_SIZE = 1000;
    
    Logger logger;
    
public:
    SystemMetrics() : logger("PerformanceMonitor") {}
    
    struct MetricSnapshot {
        std::chrono::steady_clock::time_point timestamp;
        double cpu_usage;
        double memory_usage;
        double disk_usage;
        double network_rx;
        double network_tx;
        std::vector<ProcessInfo> top_processes;
    };
    
    struct ProcessInfo {
        uint32_t pid;
        std::string name;
        double cpu_percent;
        uint64_t memory_bytes;
        std::string status;
    };
    
    void start_monitoring() {
        if (monitoring.load()) {
            return;
        }
        
        monitoring.store(true);
        monitoring_thread = std::thread(&SystemMetrics::monitor_loop, this);
        logger.info("Performance monitoring started");
    }
    
    void stop_monitoring() {
        if (!monitoring.load()) {
            return;
        }
        
        monitoring.store(false);
        if (monitoring_thread.joinable()) {
            monitoring_thread.join();
        }
        logger.info("Performance monitoring stopped");
    }
    
    MetricSnapshot get_current_metrics() {
        MetricSnapshot snapshot;
        snapshot.timestamp = std::chrono::steady_clock::now();
        
        try {
            snapshot.cpu_usage = get_cpu_usage();
            snapshot.memory_usage = get_memory_usage();
            snapshot.disk_usage = get_disk_usage();
            auto network = get_network_usage();
            snapshot.network_rx = network.first;
            snapshot.network_tx = network.second;
            snapshot.top_processes = get_top_processes(10);
        } catch (const std::exception& e) {
            logger.error("Error collecting metrics: " + std::string(e.what()));
        }
        
        return snapshot;
    }
    
    std::vector<MetricSnapshot> get_history(size_t count = 0) {
        std::lock_guard<std::mutex> lock(data_mutex);
        std::vector<MetricSnapshot> history;
        
        size_t size = metric_history.size();
        size_t items = (count == 0 || count > size) ? size : count;
        
        std::queue<MetricSnapshot> temp = metric_history;
        for (size_t i = 0; i < items && !temp.empty(); ++i) {
            history.push_back(temp.front());
            temp.pop();
        }
        
        return history;
    }
    
    std::string get_system_info() {
        std::ostringstream info;
        
#ifdef _WIN32
        SYSTEM_INFO si;
        GetSystemInfo(&si);
        
        MEMORYSTATUSEX memInfo;
        memInfo.dwLength = sizeof(MEMORYSTATUSEX);
        GlobalMemoryStatusEx(&memInfo);
        
        info << "{\n";
        info << "  \"platform\": \"Windows\",\n";
        info << "  \"processors\": " << si.dwNumberOfProcessors << ",\n";
        info << "  \"total_memory\": " << (memInfo.ullTotalPhys / 1024 / 1024) << ",\n";
        info << "  \"architecture\": \"" << (si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ? "x64" : "x86") << "\"\n";
        info << "}";
#else
        struct sysinfo si;
        sysinfo(&si);
        
        info << "{\n";
        info << "  \"platform\": \"Linux\",\n";
        info << "  \"processors\": " << get_nprocs() << ",\n";
        info << "  \"total_memory\": " << (si.totalram * si.mem_unit / 1024 / 1024) << ",\n";
        info << "  \"uptime\": " << si.uptime << "\n";
        info << "}";
#endif
        
        return info.str();
    }
    
private:
    void monitor_loop() {
        while (monitoring.load()) {
            try {
                MetricSnapshot snapshot = get_current_metrics();
                
                std::lock_guard<std::mutex> lock(data_mutex);
                metric_history.push(snapshot);
                
                if (metric_history.size() > MAX_HISTORY_SIZE) {
                    metric_history.pop();
                }
                
                // Log critical metrics
                if (snapshot.cpu_usage > 90.0) {
                    logger.warn("High CPU usage: " + std::to_string(snapshot.cpu_usage) + "%");
                }
                if (snapshot.memory_usage > 90.0) {
                    logger.warn("High memory usage: " + std::to_string(snapshot.memory_usage) + "%");
                }
                
            } catch (const std::exception& e) {
                logger.error("Monitor loop error: " + std::string(e.what()));
            }
            
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
    
#ifdef _WIN32
    double get_cpu_usage() {
        static PDH_HQUERY cpuQuery;
        static PDH_HCOUNTER cpuTotal;
        static bool initialized = false;
        
        if (!initialized) {
            PdhOpenQuery(NULL, NULL, &cpuQuery);
            PdhAddEnglishCounter(cpuQuery, L"\\Processor(_Total)\\% Processor Time", NULL, &cpuTotal);
            PdhCollectQueryData(cpuQuery);
            initialized = true;
            return 0.0;
        }
        
        PDH_FMT_COUNTERVALUE counterVal;
        PdhCollectQueryData(cpuQuery);
        PdhGetFormattedCounterValue(cpuTotal, PDH_FMT_DOUBLE, NULL, &counterVal);
        return counterVal.dblValue;
    }
    
    double get_memory_usage() {
        MEMORYSTATUSEX memInfo;
        memInfo.dwLength = sizeof(MEMORYSTATUSEX);
        GlobalMemoryStatusEx(&memInfo);
        
        DWORDLONG totalPhysMem = memInfo.ullTotalPhys;
        DWORDLONG physMemUsed = totalPhysMem - memInfo.ullAvailPhys;
        
        return (double)physMemUsed / (double)totalPhysMem * 100.0;
    }
    
    double get_disk_usage() {
        ULARGE_INTEGER freeBytesAvailable, totalNumberOfBytes, totalNumberOfFreeBytes;
        
        if (GetDiskFreeSpaceEx(L"C:\\", &freeBytesAvailable, &totalNumberOfBytes, &totalNumberOfFreeBytes)) {
            ULONGLONG usedBytes = totalNumberOfBytes.QuadPart - totalNumberOfFreeBytes.QuadPart;
            return (double)usedBytes / (double)totalNumberOfBytes.QuadPart * 100.0;
        }
        
        return 0.0;
    }
    
    std::pair<double, double> get_network_usage() {
        // Simplified network usage - would need more complex implementation for accurate results
        return {0.0, 0.0};
    }
    
    std::vector<ProcessInfo> get_top_processes(size_t count) {
        std::vector<ProcessInfo> processes;
        
        HANDLE hProcessSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (hProcessSnap == INVALID_HANDLE_VALUE) {
            return processes;
        }
        
        PROCESSENTRY32 pe32;
        pe32.dwSize = sizeof(PROCESSENTRY32);
        
        if (Process32First(hProcessSnap, &pe32)) {
            do {
                ProcessInfo info;
                info.pid = pe32.th32ProcessID;
                
                // Convert wide string to string
                std::wstring wname(pe32.szExeFile);
                info.name = std::string(wname.begin(), wname.end());
                
                HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pe32.th32ProcessID);
                if (hProcess) {
                    PROCESS_MEMORY_COUNTERS pmc;
                    if (GetProcessMemoryInfo(hProcess, &pmc, sizeof(pmc))) {
                        info.memory_bytes = pmc.WorkingSetSize;
                    }
                    CloseHandle(hProcess);
                }
                
                info.cpu_percent = 0.0; // Would need more complex calculation
                info.status = "running";
                
                processes.push_back(info);
                
            } while (Process32Next(hProcessSnap, &pe32) && processes.size() < count);
        }
        
        CloseHandle(hProcessSnap);
        
        // Sort by memory usage
        std::sort(processes.begin(), processes.end(), 
                  [](const ProcessInfo& a, const ProcessInfo& b) {
                      return a.memory_bytes > b.memory_bytes;
                  });
        
        return processes;
    }
    
#else
    double get_cpu_usage() {
        static unsigned long long lastTotalUser, lastTotalUserLow, lastTotalSys, lastTotalIdle;
        static bool first_call = true;
        
        std::ifstream file("/proc/stat");
        std::string line;
        std::getline(file, line);
        
        std::istringstream iss(line);
        std::string cpu;
        unsigned long long totalUser, totalUserLow, totalSys, totalIdle, total;
        
        iss >> cpu >> totalUser >> totalUserLow >> totalSys >> totalIdle;
        
        if (first_call) {
            lastTotalUser = totalUser;
            lastTotalUserLow = totalUserLow;
            lastTotalSys = totalSys;
            lastTotalIdle = totalIdle;
            first_call = false;
            return 0.0;
        }
        
        total = (totalUser - lastTotalUser) + (totalUserLow - lastTotalUserLow) + (totalSys - lastTotalSys);
        double percent = total;
        total += (totalIdle - lastTotalIdle);
        percent /= total;
        percent *= 100;
        
        lastTotalUser = totalUser;
        lastTotalUserLow = totalUserLow;
        lastTotalSys = totalSys;
        lastTotalIdle = totalIdle;
        
        return percent;
    }
    
    double get_memory_usage() {
        struct sysinfo memInfo;
        sysinfo(&memInfo);
        
        long long totalPhysMem = memInfo.totalram;
        totalPhysMem *= memInfo.mem_unit;
        
        long long physMemUsed = memInfo.totalram - memInfo.freeram;
        physMemUsed *= memInfo.mem_unit;
        
        return (double)physMemUsed / (double)totalPhysMem * 100.0;
    }
    
    double get_disk_usage() {
        struct statvfs stat;
        if (statvfs("/", &stat) != 0) {
            return 0.0;
        }
        
        unsigned long long total = stat.f_blocks * stat.f_frsize;
        unsigned long long available = stat.f_bavail * stat.f_frsize;
        unsigned long long used = total - available;
        
        return (double)used / (double)total * 100.0;
    }
    
    std::pair<double, double> get_network_usage() {
        std::ifstream file("/proc/net/dev");
        std::string line;
        double rx_bytes = 0, tx_bytes = 0;
        
        // Skip header lines
        std::getline(file, line);
        std::getline(file, line);
        
        while (std::getline(file, line)) {
            std::istringstream iss(line);
            std::string interface;
            unsigned long long rx, tx;
            
            iss >> interface;
            if (interface.find(':') != std::string::npos) {
                interface = interface.substr(0, interface.find(':'));
            }
            
            if (interface != "lo") { // Skip loopback
                iss >> rx;
                for (int i = 0; i < 7; ++i) iss >> rx; // Skip to tx
                iss >> tx;
                
                rx_bytes += rx;
                tx_bytes += tx;
            }
        }
        
        return {rx_bytes, tx_bytes};
    }
    
    std::vector<ProcessInfo> get_top_processes(size_t count) {
        std::vector<ProcessInfo> processes;
        
        DIR* proc_dir = opendir("/proc");
        if (!proc_dir) return processes;
        
        struct dirent* entry;
        while ((entry = readdir(proc_dir)) != nullptr && processes.size() < count) {
            if (!isdigit(entry->d_name[0])) continue;
            
            ProcessInfo info;
            info.pid = std::stoul(entry->d_name);
            
            // Read process info from /proc/[pid]/stat
            std::string stat_file = "/proc/" + std::string(entry->d_name) + "/stat";
            std::ifstream file(stat_file);
            if (!file.is_open()) continue;
            
            std::string line;
            std::getline(file, line);
            
            std::istringstream iss(line);
            std::string pid_str, comm;
            iss >> pid_str >> comm;
            
            info.name = comm.substr(1, comm.length() - 2); // Remove parentheses
            info.cpu_percent = 0.0; // Would need more complex calculation
            info.memory_bytes = 0; // Would need to read from /proc/[pid]/status
            info.status = "running";
            
            processes.push_back(info);
        }
        
        closedir(proc_dir);
        return processes;
    }
#endif
};

class WebServer {
private:
    SystemMetrics* metrics;
    std::atomic<bool> running{false};
    std::thread server_thread;
    Logger logger;
    
public:
    WebServer(SystemMetrics* m) : metrics(m), logger("WebServer") {}
    
    void start(int port = 9000) {
        if (running.load()) return;
        
        running.store(true);
        server_thread = std::thread(&WebServer::run_server, this, port);
        logger.info("Web server started on port " + std::to_string(port));
    }
    
    void stop() {
        running.store(false);
        if (server_thread.joinable()) {
            server_thread.join();
        }
        logger.info("Web server stopped");
    }
    
private:
    void run_server(int port) {
        // Simplified HTTP server implementation
        // In a real implementation, you'd use a proper HTTP library like cpp-httplib
        while (running.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
    
    std::string handle_request(const std::string& path) {
        if (path == "/health") {
            return R"({"status": "healthy", "service": "performance-monitor"})";
        } else if (path == "/metrics") {
            return format_metrics(metrics->get_current_metrics());
        } else if (path == "/history") {
            return format_history(metrics->get_history(100));
        } else if (path == "/system") {
            return metrics->get_system_info();
        }
        
        return R"({"error": "Not found"})";
    }
    
    std::string format_metrics(const SystemMetrics::MetricSnapshot& snapshot) {
        std::ostringstream json;
        json << std::fixed << std::setprecision(2);
        
        json << "{\n";
        json << "  \"timestamp\": " << std::chrono::duration_cast<std::chrono::milliseconds>(
                snapshot.timestamp.time_since_epoch()).count() << ",\n";
        json << "  \"cpu_usage\": " << snapshot.cpu_usage << ",\n";
        json << "  \"memory_usage\": " << snapshot.memory_usage << ",\n";
        json << "  \"disk_usage\": " << snapshot.disk_usage << ",\n";
        json << "  \"network_rx\": " << snapshot.network_rx << ",\n";
        json << "  \"network_tx\": " << snapshot.network_tx << ",\n";
        json << "  \"top_processes\": [\n";
        
        for (size_t i = 0; i < snapshot.top_processes.size(); ++i) {
            const auto& proc = snapshot.top_processes[i];
            json << "    {\n";
            json << "      \"pid\": " << proc.pid << ",\n";
            json << "      \"name\": \"" << proc.name << "\",\n";
            json << "      \"cpu_percent\": " << proc.cpu_percent << ",\n";
            json << "      \"memory_bytes\": " << proc.memory_bytes << ",\n";
            json << "      \"status\": \"" << proc.status << "\"\n";
            json << "    }";
            if (i < snapshot.top_processes.size() - 1) json << ",";
            json << "\n";
        }
        
        json << "  ]\n";
        json << "}";
        
        return json.str();
    }
    
    std::string format_history(const std::vector<SystemMetrics::MetricSnapshot>& history) {
        std::ostringstream json;
        json << std::fixed << std::setprecision(2);
        
        json << "{\n";
        json << "  \"data\": [\n";
        
        for (size_t i = 0; i < history.size(); ++i) {
            const auto& snapshot = history[i];
            json << "    {\n";
            json << "      \"timestamp\": " << std::chrono::duration_cast<std::chrono::milliseconds>(
                    snapshot.timestamp.time_since_epoch()).count() << ",\n";
            json << "      \"cpu_usage\": " << snapshot.cpu_usage << ",\n";
            json << "      \"memory_usage\": " << snapshot.memory_usage << ",\n";
            json << "      \"disk_usage\": " << snapshot.disk_usage << "\n";
            json << "    }";
            if (i < history.size() - 1) json << ",";
            json << "\n";
        }
        
        json << "  ],\n";
        json << "  \"count\": " << history.size() << "\n";
        json << "}";
        
        return json.str();
    }
};

int main(int argc, char* argv[]) {
    try {
        Logger logger("Main");
        logger.info("Starting Performance Monitor...");
        
        SystemMetrics metrics;
        WebServer server(&metrics);
        
        // Start monitoring
        metrics.start_monitoring();
        
        // Start web server
        int port = (argc > 1) ? std::stoi(argv[1]) : 9000;
        server.start(port);
        
        logger.info("Performance Monitor running. Press Ctrl+C to stop.");
        
        // Keep running until interrupted
        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            
            // Check for graceful shutdown signals
            // In a real implementation, you'd handle SIGINT/SIGTERM
        }
        
        // Cleanup
        server.stop();
        metrics.stop_monitoring();
        
        logger.info("Performance Monitor stopped.");
        
    } catch (const std::exception& e) {
        std::cerr << "Fatal error: " << e.what() << std::endl;
        return 1;
    }
    
    return 0;
}
