#!/usr/bin/env bash
#
# Builds Dataverse Model Designer on macOS (or Linux) and stages the single assembly that
# needs to travel to a Windows machine running XrmToolBox.
#
# Targeting .NET Framework 4.8 off Windows works out of the box: the .NET SDK automatically
# adds the Microsoft.NETFramework.ReferenceAssemblies package on a non-Windows host, so all
# you need is the .NET SDK and access to nuget.org for the first restore.
#
#   ./build-mac.sh                 # Release build, stages to dist/
#   ./build-mac.sh Debug           # Debug build (also stages the .pdb)
#
set -euo pipefail

CONFIGURATION="${1:-Release}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$ROOT/src/Oliver4.DataverseModelDesigner/Oliver4.DataverseModelDesigner.csproj"
OUTPUT="$ROOT/src/Oliver4.DataverseModelDesigner/bin/$CONFIGURATION"
DIST="$ROOT/dist"

if ! command -v dotnet >/dev/null 2>&1; then
  cat >&2 <<'MISSING'
The .NET SDK was not found on PATH.

Install it from https://dotnet.microsoft.com/download - pick the macOS .pkg for your chip
(Arm64 for Apple Silicon, x64 for Intel). The .pkg installs to /usr/local/share/dotnet and
sets PATH for you, but only for terminals opened afterwards, so open a new tab and retry.

If dotnet is installed but still not found:
    ls /usr/local/share/dotnet/dotnet          # confirm it is there
    echo 'export PATH=$PATH:/usr/local/share/dotnet' >> ~/.zshrc && source ~/.zshrc
MISSING
  exit 1
fi

echo "SDK $(dotnet --version) on $(uname -s)"
echo "Building $CONFIGURATION..."
dotnet build "$PROJECT" -c "$CONFIGURATION" --nologo

ASSEMBLY="$OUTPUT/Oliver4.DataverseModelDesigner.dll"
if [ ! -f "$ASSEMBLY" ]; then
  echo "Build output not found at $ASSEMBLY" >&2
  exit 1
fi

# Stage only our own assembly. The build folder also holds the Dataverse SDK, WebView2,
# Newtonsoft.Json and DockPanelSuite, all of which XrmToolBox already ships - copying its
# own dependencies over the top is the usual cause of a tool that never appears in the list.
rm -rf "$DIST"
mkdir -p "$DIST"
cp "$ASSEMBLY" "$DIST/"

if [ "$CONFIGURATION" = "Debug" ] && [ -f "$OUTPUT/Oliver4.DataverseModelDesigner.pdb" ]; then
  cp "$OUTPUT/Oliver4.DataverseModelDesigner.pdb" "$DIST/"
fi

echo
echo "Staged in dist/:"
ls -la "$DIST"
echo
cat <<'NEXT'
Next, on the Windows machine:

  1. Close XrmToolBox.
  2. Copy the contents of dist/ into %APPDATA%\MscrmTools\XrmToolBox\Plugins
  3. If the file arrived by download, email or an untrusted zip, unblock it:
         Unblock-File "$env:APPDATA\MscrmTools\XrmToolBox\Plugins\Oliver4.DataverseModelDesigner.dll"
  4. Start XrmToolBox and look for "Dataverse Model Designer".
NEXT
