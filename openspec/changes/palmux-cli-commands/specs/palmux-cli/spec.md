# Spec Delta

## Purpose

The `palmux` command, run from a shell on the palmux host, drives the palmux window that shell is shown
in (download, open a file, open Source Control) and hands review comments to whatever runs it.

## ADDED Requirements

### Requirement: The CLI finds its terminal by tty

A command that acts on a window SHALL name the palmux terminal it runs in by its tty. Inside tmux it
SHALL use the tty of the tmux client showing the session, not the pane's own tty. The server SHALL act
on the browser window whose data socket is attached to that terminal, the last attach winning.

#### Scenario: A plain palmux shell

- **WHEN** the user runs `palmux download a.txt` in a palmux terminal on `pts/11`
- **THEN** the window showing that terminal downloads `a.txt`

#### Scenario: Inside tmux

- **WHEN** the user runs a window command in a tmux pane whose tmux client runs in the palmux terminal on `pts/11`
- **THEN** the command acts on the window showing the terminal on `pts/11`

#### Scenario: Not in a palmux terminal

- **WHEN** a window command runs on a tty no palmux terminal is on, or on one no window is attached to
- **THEN** the CLI prints that it must run inside a palmux terminal and exits 1

#### Scenario: No terminal at all

- **WHEN** a window command runs with no tty on its standard streams and outside tmux
- **THEN** the CLI prints that the shell has no terminal and exits 1 without contacting the server

### Requirement: Only the CLI may use the CLI endpoint

The endpoint the CLI posts to SHALL require the same session as every other route, and SHALL refuse any
request that carries an `Origin` header with 403, because a browser page sends one and its cookie would
ride along. A malformed request SHALL be refused with 400 and changes nothing.

#### Scenario: A browser page posts

- **WHEN** a request to the CLI endpoint carries an `Origin` header
- **THEN** it is answered 403 and nothing is sent to any window

#### Scenario: A malformed request

- **WHEN** a request names no command, an unknown command, or omits a field its command needs
- **THEN** it is answered 400 and nothing is sent to any window

### Requirement: Paths are read the way the shell reads them

A path argument SHALL be sent as typed when it is absolute or starts with `~/` (or is `~`), and
otherwise SHALL be resolved against the shell's current directory. The server SHALL read a leading `~`
as its own home. `~user` SHALL NOT be expanded.

#### Scenario: A relative path

- **WHEN** the user runs `palmux open src/a.ts` in `/home/u/app`
- **THEN** the file opened is `/home/u/app/src/a.ts`

#### Scenario: A home path

- **WHEN** the user runs `palmux open ~/notes.md`
- **THEN** the file opened is `notes.md` in the server's home directory

### Requirement: palmux download downloads into the window

`palmux download <path>...` SHALL make the window download each path, in the order given, as the rail's
Download would: a file as itself, a folder or a quoted glob as one zip (or as the file when it holds just
one). A path that cannot be downloaded SHALL be listed with its reason, the others still go, and the
exit status SHALL be 1 when any path failed.

#### Scenario: One path is missing

- **WHEN** the user runs `palmux download a.txt nope.txt b.txt` and `nope.txt` does not exist
- **THEN** the window downloads `a.txt` then `b.txt`, the CLI prints `nope.txt: not found`, and exits 1

#### Scenario: A glob

- **WHEN** the user runs `palmux download '*.mp4'` in a folder holding three `.mp4` files
- **THEN** the window downloads one zip holding the three files and the CLI exits 0

### Requirement: palmux open opens files in the window

`palmux open <path>...` SHALL open each file as a pinned editor tab in the window, in the order given,
showing the last one. A file already open in that window SHALL be selected, not opened twice. A path
that is missing, a directory, not a regular file or over the editor's size limit SHALL be refused
before anything is sent, with its reason.

#### Scenario: Open one file

- **WHEN** the user runs `palmux open ./a.ts` and `a.ts` is not open
- **THEN** the window opens a pinned editor tab on `a.ts`, shows it, and the CLI exits 0

#### Scenario: Already open

- **WHEN** the user runs `palmux open a.ts` and the window already has `a.ts` open
- **THEN** that tab is selected, no second tab is created, and the CLI exits 0

#### Scenario: A directory

- **WHEN** the user runs `palmux open src`
- **THEN** the CLI prints `src: path is a directory`, nothing is opened, and it exits 1

#### Scenario: Open in another window

- **WHEN** the user runs `palmux open a.ts` and another palmux window holds the tab for `a.ts`
- **THEN** the window shows that the file is open in another window, no tab is created or moved, the
  CLI prints the same, and exits 1

### Requirement: palmux git opens Source Control for the shell's repository

`palmux git` SHALL find the top level of the git work tree the shell's directory is in, from any folder
inside it. In the window it SHALL add that top to the project list when it is missing, make it the
active project on that window's device, and open Source Control there. Outside a work tree it SHALL
change nothing and exit 1 with the reason.

#### Scenario: From a nested folder

- **WHEN** the user runs `palmux git` in `/home/u/dgsl/apps/frontoffice/lib` and `/home/u/dgsl` is the work tree's top
- **THEN** the window's Source Control opens on `/home/u/dgsl`, which is now in the project list and active, and the CLI exits 0

#### Scenario: A project already in the list

- **WHEN** the user runs `palmux git` in a repository already in the project list
- **THEN** the list is unchanged, that project becomes active and Source Control opens on it

#### Scenario: Not a repository

- **WHEN** the user runs `palmux git` in a folder outside any git work tree
- **THEN** the CLI prints that the path is not inside a git work tree, nothing changes, and it exits 1

#### Scenario: A window with no Source Control panel

- **WHEN** the user runs `palmux git` in a terminal shown in a detached window
- **THEN** the project is added and made active, the CLI prints that this window has no Source Control panel, and it exits 0

### Requirement: The window reports what it did

For `open` and `git` the window SHALL report its outcome to the server, and the CLI SHALL print it and
exit 0 only when every requested action succeeded. When no window reports within 3 seconds the CLI SHALL
print that no palmux window answered and exit 1.

#### Scenario: A window on an older bundle

- **WHEN** the window attached to the terminal runs a client that does not know the command
- **THEN** after 3 seconds the CLI prints that no palmux window answered and exits 1

#### Scenario: The window answers

- **WHEN** the window opens the file it was asked to open
- **THEN** the CLI prints the opened path and exits 0 without waiting the full 3 seconds

### Requirement: palmux comments prints the repository's comments

`palmux comments` SHALL print to standard output every review comment of the git work tree the shell's
directory is in, as the same markdown Copy comments produces for that project, outdated and not-shown
comments marked the same way. It SHALL NOT need a palmux terminal or an open window, and SHALL NOT
change any staging state.

#### Scenario: An agent reads the comments

- **WHEN** Claude Code runs `palmux comments` as a subprocess in a repository with three comments in two files
- **THEN** standard output holds the agent preamble, two file sections and the three comments, and the exit status is 0

#### Scenario: Same text as the button

- **WHEN** the user chooses Copy comments for a project and then runs `palmux comments` in it with nothing changed in between
- **THEN** the clipboard and standard output hold the same text

#### Scenario: No comments

- **WHEN** the repository has no comments
- **THEN** nothing is printed and the exit status is 0

#### Scenario: Outside a repository

- **WHEN** `palmux comments` runs in a folder outside any git work tree
- **THEN** it prints that the path is not inside a git work tree to standard error and exits 1

### Requirement: The server names the commands it supports

Every answer of the CLI endpoint, refusals included, SHALL list the commands the running server
supports. When the server does not list the command it was asked for, or its answer is not the
endpoint's JSON, the CLI SHALL print that this palmux server predates that command and must be
restarted, and exit 1.

#### Scenario: A newer CLI against an older server

- **WHEN** the user runs `palmux open a.ts` against a server that supports only `download`
- **THEN** the CLI prints that this palmux server predates `palmux open` and must be restarted, and exits 1

### Requirement: Every CLI request is logged

The server SHALL log one line per CLI request naming the command, the tty when there is one, and the
outcome (the status and, for a window command, what the window reported or that it did not answer).
The line SHALL NOT include file contents or comment text.

#### Scenario: An open is logged

- **WHEN** a `palmux open` request is answered
- **THEN** the server log holds one line with `open`, the tty and the outcome

### Requirement: Usage and exit statuses are fixed

`palmux`, `palmux help`, `-h` and `--help` SHALL print the usage and exit 0. An unknown command, or a
command missing an argument it needs, SHALL print the usage to standard error and exit 2. A failure SHALL
exit 1. An unreachable server SHALL print that it cannot reach the palmux server and exit 1.

#### Scenario: An unknown command

- **WHEN** the user runs `palmux frobnicate`
- **THEN** the usage is printed to standard error and the exit status is 2

#### Scenario: open with no path

- **WHEN** the user runs `palmux open`
- **THEN** the usage is printed to standard error and the exit status is 2

#### Scenario: The server is down

- **WHEN** the user runs any command while no palmux server listens on the configured port
- **THEN** the CLI prints that it cannot reach the palmux server and exits 1
