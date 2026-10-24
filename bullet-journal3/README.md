# Bullet Journal

A local note-taking app in the bullet journal style: daily, weekly and monthly logs, plus custom logs of your own, with subtasks and sub logs.
Everything is saved as plain files in a folder on your computer.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```
node server.js
```

Then open http://localhost:3000.

Options:

```
node server.js "D:\Notes\Journal"     use a different journal folder
node server.js --port 4000            use a different port
node server.js --open                 open the browser automatically
```

By default the journal lives in `BulletJournal` inside your home folder. You can also set the `BUJO_DIR` environment variable.
The server only listens on your own computer (127.0.0.1).

## Where your notes live

```
BulletJournal/
  Daily/2026-10-18.md
  Weekly/2026-W42.md
  Monthly/2026-10.md
  Custom Logs/
    Groceries/
      log.md            the bullets of this log
      recipe.md         any file you put in the folder shows up in the app
      receipts/oct.pdf  subfolders work too
      Costco/           a sub log: a folder inside a log that has its own log.md
        log.md
        list.txt
```

Every custom log is a folder. Create one in the app (New log) or just create a folder inside `Custom Logs`.
Add, rename or delete files in that folder with your file manager and the app picks it up within a couple of seconds.
Markdown and text files can be opened and edited in the app, images, PDFs, audio and video can be previewed.
You can also drop files onto the Files panel of a log to copy them into its folder.

### Sub logs

A custom log can hold sub logs, up to three levels deep (a log, a sub log, and a sub log of that).
Open a log and choose **New sub log**, or create a folder inside the log's folder and put a `log.md` in it.
A folder without a `log.md`, like `receipts/` above, stays an ordinary file folder.

- Sub logs appear nested in the sidebar and as stacked cards at the top of their parent log.
- Each sub log has its own bullets and its own Files panel. Its files are not listed in the parent.
- Tag a task with the path to file it there: `Buy olive oil #groceries/costco` (or `#groceries-costco`).
- Renaming a sub log renames its folder. Deleting a log moves it and its sub logs to `.trash`.

Deleted files and logs are moved to `.trash` inside the journal folder, never erased.

## Film projects

Choose **New log**, then **Film project**. A film project is a log whose sub logs have a type. Inside it choose **New sub log** and pick one:

1. Brain dump: a board of sticky notes. Type something, attach or drop files, paste a link or image, or draw, and it becomes a sticky you can drag and resize. Tags sit above the content. Use a sticky's "..." menu to attach it to a scene or shot, or turn it into one.
2. Moodboard: drop in images and files, tag any of them.
3. Script writer: **Write** mode for scene headings, action, dialogue (Enter adds the next line). Every scene heading becomes a scene (Scene 1, Scene 2...). Switch to **Tag** mode, select words, and choose Cast, Prop, Location, Costume, Vehicle or Other. They are highlighted and filed under their scene.
4. Shot list: shots live under each scene and are named after it (1A, 1B, 2A...). Each has size, movement, description and extra tags.
5. Storyboard: every shot gets a frame (image and caption), grouped by scene.
6. Breakdown: **By scene** shows the cast, props, locations and so on of each scene plus its shots. **By element** shows where one element appears (scenes, shots, script lines, snippets, files).
7. Schedule: set the day and time for each shot. Shots are grouped by shooting day.

Tags belong to the whole project. Select any tag, anywhere, to see everything that carries it.
Tag data lives in hidden `.project.json` and `.sublog.json` files inside the log folders.

## Same name, same task

A task is identified by its name (ignoring capital letters and extra spaces). If "Buy milk" is in your Daily log and in your Groceries log, it is one task:

- marking it done or open in one place changes it everywhere
- renaming it in one place renames it everywhere
- removing it from one log keeps it in the others
- small chips next to a task show where else it lives

Because of this, reuse a name only when you mean the same task. A daily habit called "Exercise" on every day would tick on every day at once. Name those differently ("Exercise Mon") or use an event or note, which never sync.

Add a task to a custom log from anywhere by ending it with the log's tag: `Buy milk #groceries`.
Use the "..." menu on a bullet to add it to another day, week, month or log afterwards.

## Subtasks

Any bullet can have subtasks (or sub notes and events), up to three levels deep.

- Hover a bullet and select **+** to add one inline. Press Enter to add the next, Escape or Done to stop.
  Start with `- ` for a note or `o ` for an event.
- A small ring and a count such as `2/5` show progress. Select it to fold the subtasks away.
- In the "..." menu, **Nest under the bullet above** and **Move out of its parent** reshape an existing list.
- Removing a bullet removes what is nested under it.
- Migrating a task carries its subtasks along: unfinished ones are marked migrated, finished ones stay behind
  as history. **Also show in** copies the subtasks too. Cancelled subtasks are left out.
- Subtasks belong to the page you add them on. Because same name means same task, a subtask also syncs its
  done, open and renamed state with any task of the same name elsewhere.
- In a file, a subtask is a bullet indented by two spaces under its parent:

```
- [ ] Plan the trip
  - [x] Book flights
  - [ ] Reserve the hotel
    - Ask about late check-in
```

## Bullets

| Mark | Meaning | In the file |
| --- | --- | --- |
| dot | open task | `- [ ] Task` |
| cross | done task | `- [x] Task` |
| arrow `>` | migrated to another day, week or month | `- [>] Task` |
| faded dot, struck through | cancelled | `- [-] Task` |
| ring | event | `- (o) Event` |
| dash | note | `- Note` |

Typing shortcuts in the quick-add box: start with `o ` for an event or `- ` for a note.
Select a bullet's text to edit it. Select its mark to complete it. Use the "..." menu to migrate, change its type or remove it.

On today's and future daily pages, unfinished tasks from the last 30 days are offered at the top so you can migrate them in one click. A subtask of an unfinished task is not offered separately, because it travels with its task.

The files are ordinary Markdown, so you can also edit them in any text editor. The app ignores lines it does not recognise and leaves them alone.
