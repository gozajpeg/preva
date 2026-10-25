import {
  isGitRepo,
  getTags,
  createTag,
  deleteTag,
  deleteRemoteTag,
  pushTag,
  getCommitDetails,
  getCommitHistory,
  runGit,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, inputPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render a compact visual table of tags.
 */
export function renderTagsTable(tags, title = 'Repository Tags', options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bold(title)} (${colors.cyan(tags.length)} tag(s)):`);
  line(colors.dim('----------------------------------------------------------------------'));

  if (tags.length === 0) {
    line(colors.dim('  No tags found in repository.'));
    line(colors.dim('----------------------------------------------------------------------\n'));
    return lines.join('\n');
  }

  tags.forEach((t) => {
    const name = colors.cyan(colors.bold(t.name.padEnd(16)));
    const badge = t.isAnnotated
      ? colors.green('[annotated] ')
      : colors.dim('[lightweight]');
    const commit = colors.yellow(`[${t.commitHash.slice(0, 7)}]`);
    const date = colors.dim(`(${t.date})`.padEnd(16));
    const author = t.author ? colors.magenta(t.author.padEnd(14)) : '';
    const subject = t.subject ? colors.dim(` ${t.subject}`) : '';

    line(`  ${name} ${badge} ${commit} ${date} ${author}${subject}`);
  });

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Format and render detailed inspection view for a single tag.
 */
export function renderTagDetails(tag, commitDetails, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bold('Tag Details:')} ${colors.cyan(colors.bold(tag.name))}`);
  line(colors.dim('----------------------------------------------------------------------'));
  line(`  ${colors.bold('Tag Name:')}     ${colors.cyan(tag.name)}`);
  line(
    `  ${colors.bold('Type:')}         ${
      tag.isAnnotated ? colors.green('Annotated Tag') : colors.yellow('Lightweight Tag')
    }`
  );
  line(`  ${colors.bold('Target Commit:')} ${colors.yellow(tag.commitHash)}`);

  if (tag.author) {
    line(`  ${colors.bold('Tagger/Author:')} ${colors.cyan(tag.author)}`);
  }
  if (tag.date) {
    line(`  ${colors.bold('Date:')}          ${tag.date}`);
  }

  if (tag.subject) {
    line(`  ${colors.bold('Message:')}       ${tag.subject}`);
  }
  if (tag.body && tag.body !== tag.subject) {
    line(`\n  ${colors.bold('Annotation Body:')}`);
    tag.body.split('\n').forEach((b) => {
      line(`    ${colors.dim(b)}`);
    });
  }

  if (commitDetails) {
    line(`\n  ${colors.bold('Target Commit Info:')}`);
    line(`    ${colors.bold('Subject:')} ${commitDetails.subject}`);
    line(`    ${colors.bold('Author:')}  ${commitDetails.author} <${commitDetails.email}>`);
    line(`    ${colors.bold('Date:')}    ${commitDetails.date} (${commitDetails.relativeDate})`);
  }

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Main entry point for preva tag / preva git tag.
 */
export async function tagCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // 1. Direct delete flag (-d or --delete)
  const isDelete = args.includes('-d') || args.includes('--delete');
  if (isDelete) {
    const targetTag = args.find((a) => a !== '-d' && a !== '--delete');
    if (!targetTag) {
      console.error(colors.red('Error: Tag name required for deletion (e.g. "preva git tag -d v1.0.0").'));
      process.exit(1);
    }
    await handleDeleteTagDirect(targetTag);
    return;
  }

  // 2. Direct list flag (-l or --list)
  const isList = args.includes('-l') || args.includes('--list');
  if (isList) {
    const pattern = args.find((a) => a !== '-l' && a !== '--list') || null;
    const tags = await getTags({ pattern });
    console.log(renderTagsTable(tags, pattern ? `Tags matching "${pattern}"` : 'Repository Tags'));
    return;
  }

  // 3. Direct create annotated tag (-a or -m)
  const isAnnotatedFlag = args.includes('-a') || args.includes('--annotate');
  const msgIndex = args.findIndex((a) => a === '-m' || a === '--message');
  let explicitMessage = null;
  if (msgIndex !== -1 && args[msgIndex + 1]) {
    explicitMessage = args[msgIndex + 1];
  }

  const cleanArgs = args.filter((a, i) => {
    if (a.startsWith('-')) return false;
    if (msgIndex !== -1 && i === msgIndex + 1) return false;
    return true;
  });

  // Direct tag creation from CLI args (e.g. preva tag v1.0.0 or preva tag -a v1.0.0 -m "release")
  if (cleanArgs.length > 0 && (isAnnotatedFlag || explicitMessage || cleanArgs.length >= 1)) {
    const tagName = cleanArgs[0];
    const targetCommit = cleanArgs[1] || 'HEAD';

    // If non-interactive or explicitly specified, create tag directly
    if (!isInteractive() || isAnnotatedFlag || explicitMessage) {
      try {
        await createTag(tagName, {
          annotated: isAnnotatedFlag || Boolean(explicitMessage),
          message: explicitMessage || tagName,
          target: targetCommit,
          force: args.includes('-f') || args.includes('--force'),
        });
        console.log(
          colors.green(`\nSuccessfully created tag ${colors.bold(tagName)} pointing to ${targetCommit}.`)
        );
        return;
      } catch (err) {
        console.error(colors.red(`\nFailed to create tag: ${err.message}`));
        process.exit(1);
      }
    }
  }

  // Non-interactive fallback: list tags cleanly
  if (!isInteractive()) {
    const tags = await getTags();
    console.log(renderTagsTable(tags));
    return;
  }

  // 4. Interactive Tag Explorer
  await handleInteractiveTagExplorer();
}

/**
 * Interactive Tag Explorer and Management Hub loop.
 */
async function handleInteractiveTagExplorer() {
  let activePattern = null;

  while (true) {
    if (isInteractive()) {
      console.clear();
    }

    const tags = await getTags({ pattern: activePattern });

    let headerTitle = 'preva tag - Tag Explorer & Release Guard';
    if (activePattern) {
      headerTitle += ` [filtered by "${activePattern}"]`;
    }

    console.log(`\n${colors.bold(headerTitle)}`);
    console.log(colors.dim('Select a tag to inspect, checkout, push, or safely delete:\n'));

    const menuChoices = [];

    if (tags.length > 0) {
      tags.forEach((t) => {
        const badge = t.isAnnotated ? colors.green('[annotated]') : colors.dim('[lightweight]');
        const commit = colors.yellow(`[${t.commitHash.slice(0, 7)}]`);
        const date = colors.dim(`(${t.date})`);
        menuChoices.push({
          value: t.name,
          name: `${t.name.padEnd(18)} ${badge} ${commit} ${date}`,
          description: `Manage tag ${t.name}`,
        });
      });
    }

    menuChoices.push({
      value: '__create_tag__',
      name: 'Create new tag           (git tag -a <name>)',
      description: 'Create a new annotated or lightweight tag',
    });

    if (!activePattern) {
      menuChoices.push({
        value: '__filter_pattern__',
        name: 'Filter tags by pattern   (git tag -l <pattern>)',
        description: 'Filter tags using glob patterns (e.g. v1.*)',
      });
    } else {
      menuChoices.push({
        value: '__clear_filter__',
        name: 'Clear active filter      (reset)',
        description: 'Show all tags in repository',
      });
    }

    menuChoices.push({
      value: '__exit__',
      name: 'Exit                     (done)',
      description: 'Close tag manager',
    });

    const choice = await selectPrompt({
      message: 'Select tag or action:',
      choices: menuChoices,
    });

    if (choice === '__exit__') {
      return;
    }

    if (choice === '__create_tag__') {
      await handleCreateTagInteractive();
      continue;
    }

    if (choice === '__filter_pattern__') {
      const pattern = await inputPrompt({
        message: 'Enter tag pattern filter:',
        placeholder: 'e.g. v1.* or *-beta',
        allowEmpty: true,
      });
      if (pattern.trim()) {
        activePattern = pattern.trim();
      }
      continue;
    }

    if (choice === '__clear_filter__') {
      activePattern = null;
      continue;
    }

    // Selected an existing tag
    const selectedTag = tags.find((t) => t.name === choice);
    if (selectedTag) {
      await handleTagActions(selectedTag);
    }
  }
}

/**
 * Handle actions for an individual tag.
 */
async function handleTagActions(tag) {
  if (isInteractive()) {
    console.clear();
  }

  const commitDetails = await getCommitDetails(tag.commitHash);
  console.log(renderTagDetails(tag, commitDetails));

  const actions = [
    {
      value: 'show',
      name: `View commit & patch      (git show ${tag.name})`,
      description: 'Inspect commit changes and unified diff',
    },
    {
      value: 'checkout',
      name: `Checkout tag             (git checkout ${tag.name})`,
      description: 'Switch to this tag in detached HEAD state',
    },
    {
      value: 'push',
      name: `Push tag to remote       (git push origin ${tag.name})`,
      description: 'Publish tag to default remote repository',
    },
    {
      value: 'delete_local',
      name: `Delete local tag         (git tag -d ${tag.name})`,
      description: 'Safely remove local tag reference',
    },
    {
      value: 'delete_remote',
      name: `Delete from remote       (git push origin --delete ${tag.name})`,
      description: 'Remove published tag from remote server',
    },
    {
      value: 'back',
      name: 'Back to tag list         (return)',
      description: 'Return to tag explorer overview',
    },
  ];

  const action = await selectPrompt({
    message: `Actions for tag "${tag.name}":`,
    choices: actions,
  });

  if (action === 'back') return;

  if (action === 'show') {
    if (isInteractive()) console.clear();
    const { stdout } = await runGit(['show', tag.name]);
    console.log(`\n${colors.bold('Git Show:')} ${colors.cyan(tag.name)}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log(stdout.trim());
    console.log(colors.dim('----------------------------------------------------------------------\n'));
    await confirmPrompt({ message: 'Press enter to return to tag menu', defaultValue: true });
    await handleTagActions(tag);
    return;
  }

  if (action === 'checkout') {
    console.log(
      colors.yellow(
        '\nNote: Checking out a tag will put you into "detached HEAD" state.\nYou can view changes, but new commits will not belong to a branch.'
      )
    );
    const confirm = await confirmPrompt({
      message: `Checkout tag ${tag.name} in detached HEAD state?`,
      defaultValue: false,
    });
    if (confirm) {
      try {
        await runGit(['checkout', tag.name]);
        console.log(colors.yellow(`\nChecked out tag ${tag.name}.`));
        await confirmPrompt({ message: 'Press enter to continue', defaultValue: true });
      } catch (err) {
        console.error(colors.red(`\nFailed to checkout tag: ${err.message}`));
      }
    }
    return;
  }

  if (action === 'push') {
    const confirm = await confirmPrompt({
      message: `Push tag ${tag.name} to origin?`,
      defaultValue: true,
    });
    if (confirm) {
      try {
        console.log(`\nPushing tag ${tag.name} to origin...`);
        const { stdout } = await pushTag(tag.name);
        console.log(colors.green(`\nSuccessfully pushed tag ${tag.name} to origin!`));
        if (stdout.trim()) console.log(colors.dim(stdout.trim()));
      } catch (err) {
        console.error(colors.red(`\nFailed to push tag: ${err.message}`));
      }
      await confirmPrompt({ message: 'Press enter to continue', defaultValue: true });
    }
    return;
  }

  if (action === 'delete_local') {
    const confirm = await confirmPrompt({
      message: `Permanently delete local tag "${tag.name}"?`,
      defaultValue: false,
    });
    if (confirm) {
      try {
        await deleteTag(tag.name);
        console.log(colors.green(`\nSuccessfully deleted local tag ${tag.name}.`));
      } catch (err) {
        console.error(colors.red(`\nFailed to delete tag: ${err.message}`));
      }
      await confirmPrompt({ message: 'Press enter to continue', defaultValue: true });
    }
    return;
  }

  if (action === 'delete_remote') {
    console.log(
      colors.red(
        '\nWARNING: Deleting a remote tag removes it from the central repository.\nOther developers who already fetched the tag may still have local copies.'
      )
    );
    const confirm = await confirmPrompt({
      message: `Are you sure you want to delete remote tag "${tag.name}" from origin?`,
      defaultValue: false,
    });
    if (confirm) {
      try {
        console.log(`\nDeleting remote tag ${tag.name} from origin...`);
        await deleteRemoteTag(tag.name);
        console.log(colors.green(`\nSuccessfully deleted tag ${tag.name} from remote origin.`));
      } catch (err) {
        console.error(colors.red(`\nFailed to delete remote tag: ${err.message}`));
      }
      await confirmPrompt({ message: 'Press enter to continue', defaultValue: true });
    }
  }
}

/**
 * Interactive Tag Creator wizard.
 */
async function handleCreateTagInteractive() {
  if (isInteractive()) console.clear();
  console.log(`\n${colors.bold('preva tag')} - Create New Tag\n`);

  // 1. Tag name
  const tagName = await inputPrompt({
    message: 'Enter tag name:',
    placeholder: 'e.g. v1.2.0 or release-2026',
    allowEmpty: false,
  });

  if (!tagName || !tagName.trim()) {
    console.log(colors.yellow('Tag creation cancelled.'));
    return;
  }

  const cleanName = tagName.trim();

  // 2. Collision check
  const existingTags = await getTags();
  const exists = existingTags.some((t) => t.name === cleanName);
  let force = false;

  if (exists) {
    console.log(colors.yellow(`\nWarning: A tag named "${cleanName}" already exists.`));
    const overwrite = await confirmPrompt({
      message: `Force overwrite existing tag "${cleanName}"? (git tag -f)`,
      defaultValue: false,
    });
    if (!overwrite) {
      console.log(colors.dim('Tag creation cancelled.'));
      await confirmPrompt({ message: 'Press enter to return to menu', defaultValue: true });
      return;
    }
    force = true;
  }

  // 3. Tag type choice
  const tagType = await selectPrompt({
    message: 'Select tag type:',
    choices: [
      {
        value: 'annotated',
        name: 'Annotated Tag (Recommended) - Includes release message, author, and date',
        description: 'Best practice for releases and versioning',
      },
      {
        value: 'lightweight',
        name: 'Lightweight Tag             - Pointer to commit without message',
        description: 'Fast temporary tag or bookmark',
      },
    ],
  });

  let message = '';
  if (tagType === 'annotated') {
    message = await inputPrompt({
      message: 'Enter tag annotation message:',
      placeholder: `Release ${cleanName}`,
      defaultValue: `Release ${cleanName}`,
      allowEmpty: false,
    });
  }

  // 4. Target commit choice
  const commitChoice = await selectPrompt({
    message: 'Select commit to tag:',
    choices: [
      {
        value: 'HEAD',
        name: 'Current HEAD                 (latest commit on current branch)',
        description: 'Tag current repository state',
      },
      {
        value: 'recent',
        name: 'Select from recent commits   (browse commit history)',
        description: 'Pick an earlier commit to tag',
      },
      {
        value: 'manual',
        name: 'Enter commit hash manually   (custom ref)',
        description: 'Type specific commit hash',
      },
    ],
  });

  let targetCommit = 'HEAD';
  if (commitChoice === 'recent') {
    const recent = await getCommitHistory({ maxCount: 15 });
    if (recent.length > 0) {
      const commitItems = recent.map((c) => ({
        value: c.hash,
        name: `[${c.hash}] ${c.subject.padEnd(36)} (${c.date})`,
        description: `Tag commit ${c.hash}`,
      }));
      commitItems.push({ value: 'HEAD', name: 'Cancel (use HEAD)', description: 'Default to HEAD' });
      targetCommit = await selectPrompt({
        message: 'Select target commit:',
        choices: commitItems,
      });
    }
  } else if (commitChoice === 'manual') {
    const inputHash = await inputPrompt({
      message: 'Enter commit hash or branch name:',
      allowEmpty: false,
    });
    if (inputHash && inputHash.trim()) {
      targetCommit = inputHash.trim();
    }
  }

  try {
    await createTag(cleanName, {
      annotated: tagType === 'annotated',
      message,
      target: targetCommit,
      force,
    });
    console.log(
      colors.green(
        `\nSuccessfully created ${tagType} tag ${colors.bold(cleanName)} pointing to ${targetCommit}!`
      )
    );

    // Offer to push tag to remote
    const shouldPush = await confirmPrompt({
      message: `Push new tag "${cleanName}" to remote origin?`,
      defaultValue: false,
    });
    if (shouldPush) {
      try {
        console.log(`\nPushing tag ${cleanName} to origin...`);
        await pushTag(cleanName);
        console.log(colors.green(`\nSuccessfully pushed tag ${cleanName} to origin!`));
      } catch (pushErr) {
        console.error(colors.red(`\nFailed to push tag: ${pushErr.message}`));
      }
    }
  } catch (err) {
    console.error(colors.red(`\nFailed to create tag: ${err.message}`));
  }

  await confirmPrompt({ message: 'Press enter to return to menu', defaultValue: true });
}

/**
 * Direct delete tag execution with confirmation guard.
 */
async function handleDeleteTagDirect(tagName) {
  const confirm = await confirmPrompt({
    message: `Delete local tag "${tagName}"?`,
    defaultValue: false,
  });

  if (!confirm) {
    console.log(colors.dim('Deletion cancelled.'));
    return;
  }

  try {
    await deleteTag(tagName);
    console.log(colors.green(`\nSuccessfully deleted local tag ${tagName}.`));
  } catch (err) {
    console.error(colors.red(`\nFailed to delete tag "${tagName}": ${err.message}`));
    process.exit(1);
  }
}
