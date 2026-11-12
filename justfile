default: check

test:
    node --test

check: test
    herdr-app check mods/gitgraph
    herdr-app check mods/ide
    herdr-app check mods/gitgraph-tabs
    herdr-app check mods/ide-new-menu
    herdr-app check mods/gitgraph-menu
    herdr-app check mods/gitgraph-pane

sync:
    bash scripts/dev-sync.sh

watch:
    bash scripts/dev-watch.sh

layout:
    bash scripts/install-layout.sh --switch

keys:
    bash scripts/install-keys.sh
