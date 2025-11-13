#!/usr/bin/env python3
"""
Command-line sliding puzzle (variable size) for manual arrangement and saving.

Controls:
 - w/a/s/d : move (one letter per move)
 - p       : save current state to `puzzle_save.json`
 - h       : help
 - q       : quit

Behavior:
 - Grid is filled left->right, top->bottom with 1..N-1 and 'X' at bottom-right as the solved configuration.
 - After each move the script prints the grid (columns separated by spaces) with leading zeros to align digits.
 - The script prints `is_solved: True` only when the current grid matches the solved configuration.
 - Saving writes a JSON file with the current grid and size.

Run:
  python3 scripts/slide_puzzle_cli.py

"""
import json
import os
import sys
import random


def create_solved_grid(rows, cols):
    total = rows * cols
    nums = [str(i) for i in range(1, total)]
    # last cell is X
    grid = []
    it = iter(nums)
    for r in range(rows):
        row = []
        for c in range(cols):
            if r == rows - 1 and c == cols - 1:
                row.append('X')
            else:
                row.append(next(it))
        grid.append(row)
    return grid


def grid_to_list(grid):
    return [cell for row in grid for cell in row]


def is_solved(grid):
    rows = len(grid)
    cols = len(grid[0])
    flat = grid_to_list(grid)
    # solved sequence should be '1','2',...,'N-1','X'
    total = rows * cols
    target = [str(i) for i in range(1, total)] + ['X']
    return flat == target


def find_X(grid):
    for r, row in enumerate(grid):
        for c, v in enumerate(row):
            if v == 'X':
                return r, c
    return None


def print_grid(grid):
    rows = len(grid)
    cols = len(grid[0])
    total = rows * cols
    max_num = total - 1
    width = max(1, len(str(max_num)))
    for r in range(rows):
        parts = []
        for c in range(cols):
            v = grid[r][c]
            if v == 'X':
                parts.append('X'.rjust(width))
            else:
                parts.append(v.zfill(width))
        print(' '.join(parts))


def swap(grid, r1, c1, r2, c2):
    grid[r1][c1], grid[r2][c2] = grid[r2][c2], grid[r1][c1]


def try_move(grid, direction):
    # direction: 'w','a','s','d' — move blank in that direction (swap with adjacent tile)
    r, c = find_X(grid)
    rows = len(grid)
    cols = len(grid[0])
    dr = dc = 0
    # Inverted mapping so pressing the key moves the tile in that direction into the blank
    # i.e. 'w' will move the tile up into the blank (so blank moves down)
    if direction == 'w':
        dr = 1
    elif direction == 's':
        dr = -1
    elif direction == 'a':
        dc = 1
    elif direction == 'd':
        dc = -1
    else:
        return False
    nr = r + dr
    nc = c + dc
    # If target position is out of bounds, move is forbidden
    if not (0 <= nr < rows and 0 <= nc < cols):
        return False
    # swap the X with the target tile
    swap(grid, r, c, nr, nc)
    return True


def save_state(grid, path='puzzle_save.json'):
    rows = len(grid)
    cols = len(grid[0])
    payload = {
        'rows': rows,
        'cols': cols,
        'grid': grid,
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    print(f"Saved state to {path}")


def generate_random_wasd_string(length):
    choices = ['w', 'a', 's', 'd']
    return ''.join(random.choice(choices) for _ in range(length))


def apply_wasd_string_to_grid(grid, s):
    # apply sequence of wasd chars to the grid; invalid moves are ignored
    for ch in s:
        if ch in ('w', 'a', 's', 'd'):
            try_move(grid, ch)



def load_state(path):
    with open(path, 'r', encoding='utf-8') as f:
        payload = json.load(f)
    return payload['grid']


def prompt_size():
    while True:
        try:
            inp = input('Enter grid size (rows cols) [e.g. 3 3]: ').strip()
            if not inp:
                continue
            parts = inp.split()
            if len(parts) != 2:
                print('Please provide two integers: rows cols')
                continue
            r = int(parts[0])
            c = int(parts[1])
            if r < 2 or c < 2:
                print('Rows and columns must be >= 2')
                continue
            return r, c
        except KeyboardInterrupt:
            print('\nAborted')
            sys.exit(0)
        except Exception as e:
            print('Invalid input:', e)


def main():
    print('Sliding Puzzle CLI — manual arrangement + save')
    # allow loading saved state if requested
    load = input('Load saved state? (y/N): ').strip().lower()
    if load == 'y':
        path = input('Path to save file [puzzle_save.json]: ').strip() or 'puzzle_save.json'
        if not os.path.exists(path):
            print('File not found:', path)
            return
        grid = load_state(path)
        rows = len(grid)
        cols = len(grid[0])
        solved_grid = create_solved_grid(rows, cols)
    else:
        rows, cols = prompt_size()
        solved_grid = create_solved_grid(rows, cols)
        grid = [row[:] for row in solved_grid]

    print('\nControls: w/a/s/d to move, p to save, h help, q quit')
    print('Note: Save uses file puzzle_save.json by default (press p).')
    print("Additional: 'r' randomize using generated WASD sequence; 'g' enter custom WASD sequence")
    print('\nInitial solved state:')
    print_grid(solved_grid)
    print('\nStart arranging (you can move tiles manually).')

    while True:
        print('\nCurrent grid:')
        print_grid(grid)
        print('is_solved:', is_solved(grid))
        cmd = input('> ').strip().lower()
        if not cmd:
            continue
        if cmd == 'q':
            print('Quitting')
            break
        if cmd == 'h':
            print('Commands: w/a/s/d to move tile into X (blank). p save, q quit')
            continue
        if cmd == 'p':
            save_state(grid)
            continue
        if cmd == 'r':
            # reasonable length heuristic: rows*cols*10
            rows = len(grid)
            cols = len(grid[0])
            length = rows * cols * 10
            s = generate_random_wasd_string(length)
            apply_wasd_string_to_grid(grid, s)
            print(f'Applied random WASD string of length {length}')
            continue
        if cmd == 'g':
            s = input('Enter WASD string (invalid moves ignored): ').strip().lower()
            apply_wasd_string_to_grid(grid, s)
            print('Applied custom WASD string')
            continue
        # accept only first char for moves to make one-letter-per-move
        ch = cmd[0]
        if ch in ('w', 'a', 's', 'd'):
            moved = try_move(grid, ch)
            if not moved:
                print('Move ignored (edge or invalid).')
            continue
        print('Unknown command. Press h for help.')


if __name__ == '__main__':
    main()
