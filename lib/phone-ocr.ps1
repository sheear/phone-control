# phone-ocr.ps1 —— 用 Windows 内置 OCR 引擎识别图片文字（简体中文，零依赖）
#
# 用法：powershell -ExecutionPolicy Bypass -File phone-ocr.ps1 <图片路径> [输出json路径]
# 输出：JSON（stdout），含整段文本与每行边界框
#
# 两个 PowerShell 5.1 的坑，这里都绕开了：
#   1) 本文件必须存为「带 BOM 的 UTF-8」，否则 5.1 按 GBK 读，中文全乱码；
#   2) Add-Type 的输出不要 pipe 到 Out-Null，否则类型解析时序会出错。

param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [string]$OutJson
)

$ErrorActionPreference = 'Stop'

# 控制台输出编码固定为 UTF-8。
# 否则 PS 5.1 会按系统 ANSI（中文机器上是 GBK）写 stdout，调用方按 UTF-8 解码全是乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not (Test-Path -LiteralPath $ImagePath)) {
    Write-Error "image not found: $ImagePath"
    exit 1
}

# WinRT 异步 -> .NET Task 桥接（PS 5.1 无 await 语法）
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
if ($null -eq $asTaskGeneric) {
    Write-Error 'AsTask bridge not found; this PowerShell cannot await WinRT'
    exit 1
}

function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

# 载入 WinRT 投影类型
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
# Language 也要显式载入投影，否则 New-Object 报 TypeNotFound
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$fullPath = (Resolve-Path -LiteralPath $ImagePath).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

# OCR 引擎有尺寸上限，超了就缩放（手机截图 1440x3168 一般没问题）
$maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$scale = 1.0
if ($decoder.PixelWidth -gt $maxDim -or $decoder.PixelHeight -gt $maxDim) {
    $scale = [Math]::Min($maxDim / $decoder.PixelWidth, $maxDim / $decoder.PixelHeight)
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $transform.ScaledWidth = [uint32][Math]::Floor($decoder.PixelWidth * $scale)
    $transform.ScaledHeight = [uint32][Math]::Floor($decoder.PixelHeight * $scale)
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb
    )) ([Windows.Graphics.Imaging.SoftwareBitmap])
} else {
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
}

# 优先简体中文引擎
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'zh-Hans-CN'))
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) {
    Write-Error 'no OCR engine available (missing language pack)'
    exit 1
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

# 每行文本 + 边界框（坐标按缩放还原到原图）
$lines = @()
foreach ($line in $result.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0; $maxY = 0
    foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        if ($r.X -lt $minX) { $minX = $r.X }
        if ($r.Y -lt $minY) { $minY = $r.Y }
        if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    $lines += [ordered]@{
        text = $line.Text
        box  = @(
            [int][Math]::Round($minX / $scale),
            [int][Math]::Round($minY / $scale),
            [int][Math]::Round($maxX / $scale),
            [int][Math]::Round($maxY / $scale)
        )
    }
}

$out = [ordered]@{
    image     = $fullPath
    width     = $decoder.PixelWidth
    height    = $decoder.PixelHeight
    language  = $engine.RecognizerLanguage.LanguageTag
    scale     = $scale
    lineCount = $lines.Count
    text      = $result.Text
    lines     = $lines
}

$json = $out | ConvertTo-Json -Depth 6 -Compress
if ($OutJson) {
    # 必须用 UTF8Encoding($false)：[System.Text.Encoding]::UTF8 写文件会带 BOM，
    # 下游 JSON.parse 会因 BOM 直接抛错（踩过）。
    [System.IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding $false))
} else {
    Write-Output $json
}

$stream.Dispose()
