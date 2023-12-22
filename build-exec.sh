PREFIX="#!/usr/bin/env node"
DIST_FILE=dist/index.min.js
CONFIG_EXP=config-example.json

EXEC_DIR=exec
EXEC_CMD=restart-modem
EXEC_CFG=config.json

mkdir -p $EXEC_DIR
echo $PREFIX | cat - $DIST_FILE > $EXEC_DIR/$EXEC_CMD
chmod +x $EXEC_DIR/$EXEC_CMD
cp $CONFIG_EXP $EXEC_DIR/$EXEC_CFG