# Spec Delta

## MODIFIED Requirements

### Requirement: The view starts with no project

The Source Control view SHALL show no repository until the user adds a project path. It MUST NOT infer
a project from the server's working directory, the user's home, a terminal's cwd or any open file. With
no project added, the view SHALL show an empty state that offers to add one. The one exception is an
explicit request: `palmux git` names its shell's directory as the project to add, and that request SHALL
be validated and stored exactly as a path the user typed into Add project.

#### Scenario: First open

- **WHEN** the user opens Source Control on a palmux that has no project added
- **THEN** the view shows an empty state with an Add project control and runs no git command

#### Scenario: A terminal's directory is not a project by itself

- **WHEN** a terminal's shell is inside a git work tree and the user never added it nor ran `palmux git` there
- **THEN** the project list does not gain that work tree

#### Scenario: palmux git adds the project

- **WHEN** the user runs `palmux git` in `/home/u/work/app/src` and `/home/u/work/app` is the work tree's top level
- **THEN** the project list gains `/home/u/work/app`, it becomes the active project on that window's
  device, and the list is saved the same way an Add project would save it
