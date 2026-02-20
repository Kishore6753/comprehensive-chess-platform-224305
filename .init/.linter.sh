#!/bin/bash
cd /home/kavia/workspace/code-generation/comprehensive-chess-platform-224305/chess_frontend
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

