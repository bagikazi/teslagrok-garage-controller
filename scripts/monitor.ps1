param([Parameter(Mandatory=$true)][string]$Port, [int]$Baud = 115200)
$ErrorActionPreference = "Stop"
idf.py -p $Port monitor -b $Baud
