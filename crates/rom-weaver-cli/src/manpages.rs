use std::{
    collections::BTreeMap,
    env, fs, io,
    path::{Path, PathBuf},
};

use clap::Command;

fn assert_documented(command: &Command, path: &[String]) {
    let invocation = path.join(" ");
    assert!(
        command.get_about().is_some(),
        "visible command `{invocation}` is missing about text"
    );
    for argument in command
        .get_arguments()
        .filter(|argument| !argument.is_hide_set())
    {
        assert!(
            argument.get_help().is_some(),
            "visible argument `{}` on `{invocation}` is missing help text",
            argument.get_id()
        );
    }
    for subcommand in command
        .get_subcommands()
        .filter(|subcommand| !subcommand.is_hide_set() && subcommand.get_name() != "help")
    {
        let mut subcommand_path = path.to_vec();
        subcommand_path.push(subcommand.get_name().to_string());
        assert_documented(subcommand, &subcommand_path);
    }
}

fn collect_pages(command: &Command, path: &[String], pages: &mut BTreeMap<String, Vec<u8>>) {
    let page_name = path.join("-");
    let invocation = path.join(" ");
    let mut page_command = command.clone().name(page_name.clone()).bin_name(invocation);
    for subcommand in page_command
        .get_subcommands_mut()
        .filter(|subcommand| subcommand.get_name() == "help")
    {
        *subcommand = subcommand.clone().hide(true);
    }
    page_command.build();

    let mut rendered = Vec::new();
    clap_mangen::Man::new(page_command)
        .render(&mut rendered)
        .expect("render man page");
    let rendered = String::from_utf8(rendered)
        .expect("man page is UTF-8")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    pages.insert(format!("{page_name}.1"), rendered.into_bytes());

    for subcommand in command
        .get_subcommands()
        .filter(|subcommand| !subcommand.is_hide_set() && subcommand.get_name() != "help")
    {
        let mut subcommand_path = path.to_vec();
        subcommand_path.push(subcommand.get_name().to_string());
        collect_pages(subcommand, &subcommand_path, pages);
    }
}

/// Render the same man pages that release packaging publishes.
pub fn generated_man_pages() -> BTreeMap<String, Vec<u8>> {
    let mut command = crate::cli::cli_command();
    command.build();
    let root = command.get_name().to_string();
    assert_documented(&command, std::slice::from_ref(&root));
    let mut pages = BTreeMap::new();
    collect_pages(&command, &[root], &mut pages);
    pages
}

pub fn page_name(topics: &[String]) -> String {
    let path = match topics {
        [root, ..] if root == "rom-weaver" => topics.to_vec(),
        [page] if page.starts_with("rom-weaver-") => topics.to_vec(),
        _ => std::iter::once("rom-weaver".to_string())
            .chain(topics.iter().cloned())
            .collect(),
    };
    format!("{}.1", path.join("-"))
}

pub fn default_man_dir() -> PathBuf {
    if let Some(path) = env::var_os("ROM_WEAVER_MAN_DIR") {
        return PathBuf::from(path);
    }

    #[cfg(windows)]
    {
        if let Some(path) = env::var_os("LOCALAPPDATA") {
            return PathBuf::from(path)
                .join("rom-weaver")
                .join("docs")
                .join("man");
        }
        return PathBuf::from("docs").join("man");
    }

    #[cfg(not(windows))]
    {
        if let Some(path) = env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(path).join("man").join("man1");
        }
        if let Some(path) = env::var_os("HOME") {
            return PathBuf::from(path).join(".local/share/man/man1");
        }
        PathBuf::from("man").join("man1")
    }
}

pub fn write_man_pages(
    pages: &BTreeMap<String, Vec<u8>>,
    output_dir: &Path,
    selected_page: Option<&str>,
) -> io::Result<usize> {
    fs::create_dir_all(output_dir)?;
    let entries = pages.iter().filter(|(name, _)| {
        selected_page.is_none_or(|selected_page| selected_page == name.as_str())
    });
    let mut count = 0;
    for (name, contents) in entries {
        fs::write(output_dir.join(name), contents)?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use assert_fs::TempDir;

    use super::{default_man_dir, generated_man_pages, page_name, write_man_pages};

    #[test]
    fn generated_pages_include_the_man_installer() {
        let pages = generated_man_pages();
        assert!(pages.contains_key("rom-weaver.1"));
        assert!(pages.contains_key("rom-weaver-man.1"));
    }

    #[test]
    fn page_names_accept_paths_and_canonical_names() {
        assert_eq!(page_name(&[]), "rom-weaver.1");
        assert_eq!(
            page_name(&["patch".to_string(), "apply".to_string()]),
            "rom-weaver-patch-apply.1"
        );
        assert_eq!(
            page_name(&["rom-weaver-patch-apply".to_string()]),
            "rom-weaver-patch-apply.1"
        );
    }

    #[test]
    fn writes_all_or_one_page_without_removing_other_files() {
        let pages = generated_man_pages();
        let directory = TempDir::new().expect("create temp directory");
        std::fs::write(directory.path().join("keep.txt"), "keep").expect("write sentinel");

        let count = write_man_pages(&pages, directory.path(), None).expect("write pages");
        assert_eq!(count, pages.len());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("keep.txt")).expect("read sentinel"),
            "keep"
        );

        let selected = TempDir::new().expect("create selected temp directory");
        let count = write_man_pages(&pages, selected.path(), Some("rom-weaver-extract.1"))
            .expect("write selected page");
        assert_eq!(count, 1);
        assert!(selected.path().join("rom-weaver-extract.1").is_file());
        assert!(!selected.path().join("rom-weaver.1").exists());
    }

    #[test]
    fn default_path_has_a_user_scope() {
        let path = default_man_dir();
        assert!(!path.as_os_str().is_empty());
    }
}
