# Pinned official releases. Everything stays under this project's ignored cache.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $taskRoot '.cache\external-shogi'
$archiveRoot = Join-Path $cacheRoot 'archives'
$engineRoot = Join-Path $cacheRoot 'yaneuraou'
$weightsRoot = Join-Path $cacheRoot 'tanuki'
New-Item -ItemType Directory -Path $archiveRoot, $engineRoot, $weightsRoot -Force | Out-Null

$downloads = @(
    @{
        File = 'yaneuraou-V900-git-win64-all.7z'
        Url = 'https://github.com/yaneurao/YaneuraOu/releases/download/V9.00/yaneuraou-V900-git-win64-all.7z'
        Hash = '6517997dd05ba049a2244a828216967a0ad351d975ec52a0f358e2883197dec6'
    },
    @{
        File = 'tanuki-halfkp256.7z'
        Url = 'https://github.com/nodchip/tanuki-/releases/download/tanuki-.halfkp_256x2-32-32.2023-05-08/tanuki-.halfkp_256x2-32-32.2023-05-08.7z'
        Hash = 'f16dc66c529857bf08fce8cee4f1e53a6993297644100267a6ccccd62e43dbba'
    }
)
foreach ($download in $downloads) {
    $archivePath = Join-Path $archiveRoot $download.File
    if (-not (Test-Path -LiteralPath $archivePath)) {
        Invoke-WebRequest -Uri $download.Url -OutFile $archivePath -UseBasicParsing
    }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $download.Hash) {
        throw "Archive checksum differs: $archivePath"
    }
}

$engineMember = 'NNUE_halfkp_256x2_32_32/YaneuraOu_NNUE_halfkp_256x2_32_32-V900Git_AVX2.exe'
& tar -xf (Join-Path $archiveRoot $downloads[0].File) -C $engineRoot $engineMember
if ($LASTEXITCODE -ne 0) { throw 'Could not extract YaneuraOu' }
& tar -xf (Join-Path $archiveRoot $downloads[1].File) -C $weightsRoot 'eval/nn.bin' 'gpl-3.0.txt'
if ($LASTEXITCODE -ne 0) { throw 'Could not extract the evaluation function' }
Write-Output 'YaneuraOu V9.00 + Hao HalfKP256 ready (Windows AVX2).'
