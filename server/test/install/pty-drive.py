#!/usr/bin/env python3
"""Запуск команды в псевдотерминале с заранее заданными ответами на вопросы (проверка интерактивного режима install.sh).

    pty-drive.py журнал.txt '[["регулярное выражение вопроса", "ответ"], ...]' -- команда аргументы...

Вопросы ожидаются строго по порядку: ответ отправляется, когда в новом выводе встретится очередное выражение. Весь вывод
(включая то, что напечатал терминал) пишется в журнал. Код возврата — код команды; 3 — не на все ответы нашлись вопросы,
124 — истекло время. Ввод скрытых полей (read -s) терминал не отображает, поэтому в журнале его нет.
"""
import json
import os
import pty
import re
import select
import sys
import time

log_path, answers_json = sys.argv[1], sys.argv[2]
command = sys.argv[sys.argv.index('--') + 1:]
answers = json.loads(answers_json)

pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

deadline = time.time() + 1800
pending = b''
answered = 0
with open(log_path, 'wb') as log:
    while True:
        if time.time() > deadline:
            os.kill(pid, 9)
            sys.exit(124)
        ready, _, _ = select.select([fd], [], [], 1)
        if not ready:
            continue
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        log.write(data)
        log.flush()
        pending += data
        if answered < len(answers):
            pattern, reply = answers[answered]
            if re.search(pattern.encode('utf-8'), pending):
                reply = reply.replace('{{CODE}}', os.environ.get('PTY_CODE', ''))
                os.write(fd, (reply + '\n').encode('utf-8'))
                answered += 1
                pending = b''

_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
if answered != len(answers):
    print(f'Не на все ответы нашлись вопросы: {answered} из {len(answers)}', file=sys.stderr)
    sys.exit(3 if code == 0 else code)
sys.exit(code)
