[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(0, 65535)]
    [int]$Port = $(if ($env:PORT) { $env:PORT } else { 5173 }),
    [string]$NodePath = '',
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

try {
    if ($Port -eq 0 -or $env:HOST -in @('localhost', '127.0.0.1', '::1')) {
        Write-Host '[FIREWALL] Skipped for a dynamic port or localhost-only server.'
        exit 0
    }
    if (-not $NodePath) { $NodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source }
    $taskNode = (Get-Item -LiteralPath $NodePath).FullName
    $taskRuleName = "SimultaneousShogi-Game-TCP-$Port"

    function Test-GameFirewallRule {
        $taskRules = @(Get-NetFirewallRule -Name $taskRuleName -PolicyStore ActiveStore -ErrorAction SilentlyContinue)
        foreach ($taskRule in $taskRules) {
            $taskApplication = $taskRule | Get-NetFirewallApplicationFilter
            $taskPorts = $taskRule | Get-NetFirewallPortFilter
            if ($taskRule.Enabled -eq 'True' -and $taskRule.Direction -eq 'Inbound' -and $taskRule.Action -eq 'Allow' -and
                [string]$taskRule.Profile -eq 'Any' -and $taskApplication.Program -eq $taskNode -and
                [string]$taskPorts.Protocol -in @('TCP', '6') -and @($taskPorts.LocalPort).Count -eq 1 -and
                [string]$taskPorts.LocalPort -eq [string]$Port) { return $true }
        }
        return $false
    }

    if (Test-GameFirewallRule) {
        Write-Host "[FIREWALL] Already allowed: Node.js, inbound TCP $Port (IPv4/IPv6)."
        exit 0
    }
    if (-not $PSCmdlet.ShouldProcess("$taskNode, inbound TCP $Port (IPv4/IPv6)", 'Allow Simultaneous Shogi in Windows Firewall')) { exit 0 }

    $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $taskPrincipal = [Security.Principal.WindowsPrincipal]::new($taskIdentity)
    if (-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        if ($Elevated) { throw 'Administrator rights were not granted.' }
        Write-Host '[FIREWALL] Windows administrator approval is needed to add the game rule.'
        Write-Host '[FIREWALL] Accept the Windows UAC prompt. Existing valid rules need no further approval.'
        $taskScriptLiteral = $PSCommandPath.Replace("'", "''")
        $taskNodeLiteral = $taskNode.Replace("'", "''")
        $taskCommand = "& '$taskScriptLiteral' -Port $Port -NodePath '$taskNodeLiteral' -Elevated"
        $taskEncodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskCommand))
        $taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $taskHelper = Start-Process -FilePath $taskPowerShell -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $taskEncodedCommand
        )
        if ($taskHelper.ExitCode -ne 0) { throw "Firewall setup failed (exit code $($taskHelper.ExitCode)). Run start-server.bat as administrator to see details." }
    } else {
        $taskSettings = @{
            Name = $taskRuleName
            PolicyStore = 'PersistentStore'
            Description = "Allow direct Simultaneous Shogi connections to Node.js on TCP $Port (IPv4 and IPv6)."
            Enabled = 'True'
            Direction = 'Inbound'
            Action = 'Allow'
            Profile = 'Any'
            Program = $taskNode
            Protocol = 'TCP'
            LocalPort = [string]$Port
            RemotePort = 'Any'
            LocalAddress = 'Any'
            RemoteAddress = 'Any'
            EdgeTraversalPolicy = 'Block'
        }
        if (Get-NetFirewallRule -Name $taskRuleName -PolicyStore PersistentStore -ErrorAction SilentlyContinue) {
            Set-NetFirewallRule @taskSettings
        } else {
            New-NetFirewallRule @taskSettings -DisplayName "Simultaneous Shogi - TCP $Port" -Group 'Simultaneous Shogi' | Out-Null
        }
    }

    if (-not (Test-GameFirewallRule)) { throw 'The game firewall rule could not be verified in the active Windows policy.' }
    Write-Host "[FIREWALL] Allowed: Node.js, inbound TCP $Port (IPv4/IPv6)."
} catch {
    $taskCause = $_.Exception
    while ($taskCause.InnerException) { $taskCause = $taskCause.InnerException }
    if ($taskCause -is [ComponentModel.Win32Exception] -and $taskCause.NativeErrorCode -eq 1223) {
        Write-Host '[ERROR] Windows administrator approval was canceled. Firewall setup was not completed.'
        Write-Host '[INFO] Start the BAT again and accept the Windows UAC prompt to allow the game port.'
    } else {
        Write-Host "[ERROR] $($_.Exception.Message)"
    }
    exit 1
}
