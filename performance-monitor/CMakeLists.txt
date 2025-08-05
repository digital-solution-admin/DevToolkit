cmake_minimum_required(VERSION 3.10)
project(PerformanceMonitor)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Add executable
add_executable(performance_monitor src/main.cpp)

# Include directories
target_include_directories(performance_monitor PRIVATE include)

# Compiler-specific options
if(CMAKE_COMPILER_IS_GNUCXX)
    target_compile_options(performance_monitor PRIVATE -Wall -Wextra -pedantic)
endif()

# Installation
install(TARGETS performance_monitor DESTINATION bin)
