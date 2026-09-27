#!/bin/bash
# Compila o MemeDetection.app com swiftc (basta ter os Command Line Tools:
# xcode-select --install). Uso: scripts/build-app.sh [--debug] [--arm64-only]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VERSION=$(cat VERSION)
BUILD=$ROOT/.build
DIST=$ROOT/dist
APP=$DIST/MemeDetection.app
OPT="-O"; ARCHS="arm64 x86_64"
for a in "$@"; do
  case $a in
    --debug) OPT="-Onone -g" ;;
    --arm64-only) ARCHS="arm64" ;;
  esac
done
mkdir -p "$BUILD" "$DIST"
cp Resources/ui/style.css docs/style.css   # o site usa os mesmos estilos do app

# Alguns Command Line Tools (macOS 26) trazem module.modulemap e bridging.modulemap
# definindo o mesmo módulo SwiftBridging, o que quebra qualquer compilação.
# Contorno sem mexer no sistema: um overlay VFS que esconde o arquivo duplicado.
FLAGS=()
INC="$(dirname "$(xcrun -f swiftc)")/../include/swift"
if [ -f "$INC/module.modulemap" ] && [ -f "$INC/bridging.modulemap" ] \
   && grep -q "module SwiftBridging" "$INC/module.modulemap" && grep -q "module SwiftBridging" "$INC/bridging.modulemap"; then
  INC=$(cd "$INC" && pwd)
  : > "$BUILD/empty.modulemap"
  cat > "$BUILD/overlay.yaml" <<YAML
{ "version": 0, "roots": [ { "name": "$INC", "type": "directory",
  "contents": [ { "name": "module.modulemap", "type": "file", "external-contents": "$BUILD/empty.modulemap" } ] } ] }
YAML
  FLAGS=(-vfsoverlay "$BUILD/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$BUILD/overlay.yaml")
  echo "· aplicando contorno para o modulemap duplicado dos Command Line Tools"
fi

BINS=()
for arch in $ARCHS; do
  echo "· compilando ($arch)…"
  if swiftc $OPT -target "$arch-apple-macos12.0" "${FLAGS[@]}" -module-name MemeDetection \
       Sources/MemeDetection/*.swift -o "$BUILD/MemeDetection-$arch"; then
    BINS+=("$BUILD/MemeDetection-$arch")
  else
    echo "! falha ao compilar para $arch" >&2
    [ "$arch" = "arm64" ] && exit 1
  fi
done

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "${BINS[@]}" -output "$APP/Contents/MacOS/MemeDetection"
cp -R Resources/ui Resources/model "$APP/Contents/Resources/"
[ -f Resources/AppIcon.icns ] && cp Resources/AppIcon.icns "$APP/Contents/Resources/"
sed "s/__VERSION__/$VERSION/g" Resources/Info.plist > "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"

( cd "$DIST" && rm -f MemeDetection-macOS.zip && ditto -c -k --keepParent MemeDetection.app MemeDetection-macOS.zip )
echo "✓ $APP ($(lipo -archs "$APP/Contents/MacOS/MemeDetection"))"
echo "✓ $DIST/MemeDetection-macOS.zip"
