# scripts/db-firewall.ps1 -- close the local database stacks' ports to the
# network (R-460, DEF-0059). Run ONCE, as an administrator, in PowerShell:
#
#     powershell -ExecutionPolicy Bypass -File scripts/db-firewall.ps1
#
# WHY A FIREWALL RULE. `supabase start` publishes Postgres (default password),
# the API, Studio (no sign-in) and the mail catcher (every invite and reset
# link) on every interface, and config.toml has no bind-address setting. A
# Docker network whose bridge option should bind every port to 127.0.0.1 is
# ignored by Docker Desktop 29.8 on this machine (a port published through such
# a network still came up on 0.0.0.0, 30 Sept; scripts/lib/loopbackNetwork.mjs
# has the experiment). Loopback traffic never crosses the Windows firewall, so an inbound
# BLOCK on the two stacks' port ranges keeps everything on this machine working
# and refuses anyone else on the network. A block rule wins over any allow rule.
#
# The ranges: the developer's stack 54320-54329 (supabase/config.toml) and the
# tester's 54420-54429 (+100, scripts/lib/testerStack.mjs). Re-running replaces
# the rule. Remove it with:  Remove-NetFirewallRule -DisplayName $name
#
# PROOF is from a second device on the same network (a phone's browser on
# http://<this machine's address>:54323 must not load Studio); the same machine
# reaching its own address does not cross the firewall and proves nothing.
$name = "production_scheduler: local database stacks answer on this machine only (R-460)"
$ports = @("54320-54329", "54420-54429")

$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) { Remove-NetFirewallRule -DisplayName $name }

New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Block -Protocol TCP `
  -LocalPort $ports -Profile Any -Enabled True | Out-Null

Write-Host "Installed: inbound TCP to ports $($ports -join ', ') is blocked on every profile."
Write-Host "Test from another device: http://<this machine's address>:54323 must not answer."
