#!/usr/bin/env sh
# Все числа из README одной командой.
#
# Критерий требует воспроизводимого сравнения и зафиксированных настроек. Проще
# всего это подтвердить так: каждое число в записке получается запуском отсюда,
# и любой из блоков можно выполнить отдельно.
#
#   sh experiments.sh            # всё подряд, около двух минут
#   sh experiments.sh sweep      # только таблицы baseline против нашего

set -e
block=${1:-all}

# Интерпретатор ищется, а не угадывается: в Git Bash `python` — заглушка,
# которая печатает своё имя и молча ничего не делает, а на сервере обычно
# есть только python3. Переопределяется переменной PYTHON.
PY=${PYTHON:-}
if [ -z "$PY" ]; then
    for candidate in python3 python "py -3"; do
        if $candidate -c "import sys; sys.exit(0)" >/dev/null 2>&1; then
            PY=$candidate
            break
        fi
    done
fi
if [ -z "$PY" ]; then
    echo "Не нашёл интерпретатор Python. Укажите его: PYTHON=python3.12 sh experiments.sh" >&2
    exit 1
fi
echo "Интерпретатор: $PY"
echo

run_block() {
    [ "$block" = all ] || [ "$block" = "$1" ]
}

if run_block sweep; then
    echo "=== Полные смены, одинаковые условия, без сообщений ==="
    $PY -m backend.cli sweep --scenarios P01_intro P02_shift P03_energy P04_demand \
        --goals priority
    echo
    echo "=== Те же смены после одинаковых сообщений ==="
    $PY -m backend.cli sweep --scenarios P02_shift P03_energy P04_demand \
        --goals priority --events examples/events_demo.json
    echo
    echo "=== Цели расходятся при перегрузке ==="
    $PY -m backend.cli sweep --scenarios P04_demand --planners cosmostars
    echo
    echo "=== Точное паросочетание для ретрансляции против жадного правила ==="
    $PY -m backend.cli sweep --scenarios P02_shift P03_energy P04_demand         --planners cosmostars cosmostars-match --goals priority
    echo
fi

if run_block ceiling; then
    echo "=== Разрыв между расписанием связи и оптимумом потока ==="
    $PY -m backend.cli ceiling
    echo
    echo "=== Потолок по ретрансляции и упущенные аппарато-шаги ==="
    $PY -m backend.cli bound
    echo
fi

if run_block feasibility; then
    echo "=== Сертификаты невыполнимости ==="
    $PY -m backend.cli feasibility --scenario P02_shift --show 5
    echo
fi

if run_block tune; then
    echo "=== Чувствительность к упреждающей калибровке ==="
    $PY -m backend.cli tune --param calibration_lead --values 0 3 6 12 24 \
        --scenarios P03_energy P04_demand
    echo
    echo "=== Чувствительность к порогу заряда для ретрансляции ==="
    $PY -m backend.cli tune --param relay_soc_floor_pct --values 0 20 40 60 \
        --scenarios P03_energy
    echo
fi

if run_block replay; then
    echo "=== Воспроизведение сохранённых расчётов выданной библиотекой ==="
    for file in examples/runs/*.json; do
        $PY model/operations.py --result "$file" --output /tmp/replay.json > /dev/null
        echo "  сошлось: $file"
    done
fi
