cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../../components/hardware"
    "${CMAKE_CURRENT_LIST_DIR}/../../components/display_ui"
    "${CMAKE_CURRENT_LIST_DIR}/../../components/vl53l0x"
)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(garage_controller_s3)
