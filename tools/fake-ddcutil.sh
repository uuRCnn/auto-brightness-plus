#!/usr/bin/env bash
# Stand-in for ddcutil in the headless test: never touches real hardware.
# Monitors: $FAKE_DDC_CONNECTORS (space separated), calls logged to $FAKE_DDC_LOG.
echo "$*" >> "${FAKE_DDC_LOG:-/dev/null}"
STATE="${FAKE_DDC_LOG:-/tmp/fake-ddc}.state"
case "$1" in
detect)
    i=0
    for c in $FAKE_DDC_CONNECTORS; do
        i=$((i + 1))
        models=("GSM:LG ULTRAGEAR:1111" "VSC:VX3211 SERIES:2222" "LEN:R27qe:3333")
        printf 'Display %d\n   I2C bus:          /dev/i2c-%d\n   DRM connector:    card1-%s\n   Monitor:          %s\n\n' \
            "$i" "$((i + 1))" "$c" "${models[$((i - 1))]}"
    done
    ;;
getvcp)
    bus="${@: -1}"
    v=$(grep "^$bus " "$STATE" 2>/dev/null | tail -1 | cut -d' ' -f2)
    echo "VCP 10 C ${v:-70} 100"
    ;;
setvcp)
    sleep 0.25   # a real DDC write takes ~250 ms
    echo "$5 $3" >> "$STATE"
    ;;
esac
