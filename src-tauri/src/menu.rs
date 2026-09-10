//! Native menus share their command catalogue with the workbench command palette.
use serde::Deserialize;
use tauri::{menu::{Menu, MenuItem, PredefinedMenuItem, Submenu}, Emitter, Manager};

#[derive(Deserialize)]
struct Group { title: String, items: Vec<Item> }
#[derive(Deserialize)]
struct Item {
    id: Option<String>, title: Option<String>, accelerator: Option<String>, native: Option<String>,
}
fn catalogue() -> Vec<Group> { serde_json::from_str(include_str!("../../src/nativeMenu.json")).expect("valid menu catalogue") }

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    {
        let application = Submenu::new(app, "AfterEdit", true)?;
        application.append(&PredefinedMenuItem::about(app, Some("About AfterEdit"), None)?)?;
        application.append(&MenuItem::with_id(app, "view.preferences", "Settings…", false, Some("CmdOrCtrl+,"))?)?;
        application.append(&PredefinedMenuItem::separator(app)?)?;
        application.append(&PredefinedMenuItem::services(app, None)?)?;
        application.append(&PredefinedMenuItem::separator(app)?)?;
        application.append(&PredefinedMenuItem::hide(app, None)?)?;
        application.append(&PredefinedMenuItem::hide_others(app, None)?)?;
        application.append(&PredefinedMenuItem::show_all(app, None)?)?;
        application.append(&PredefinedMenuItem::separator(app)?)?;
        // Close through the window lifecycle so unsaved buffers can veto quitting.
        application.append(&MenuItem::with_id(app, "window.quit", "Quit AfterEdit", true, Some("CmdOrCtrl+Q"))?)?;
        menu.append(&application)?;
    }
    for group in catalogue() {
        let submenu = Submenu::new(app, &group.title, true)?;
        for item in group.items {
            if let Some(native) = item.native {
                let predefined = match native.as_str() {
                    "separator" => PredefinedMenuItem::separator(app)?,
                    "undo" => PredefinedMenuItem::undo(app, None)?,
                    "redo" => PredefinedMenuItem::redo(app, None)?,
                    "cut" => PredefinedMenuItem::cut(app, None)?,
                    "copy" => PredefinedMenuItem::copy(app, None)?,
                    "paste" => PredefinedMenuItem::paste(app, None)?,
                    "select_all" => PredefinedMenuItem::select_all(app, None)?,
                    "minimize" => PredefinedMenuItem::minimize(app, None)?,
                    "maximize" => PredefinedMenuItem::maximize(app, Some("Zoom"))?,
                    "fullscreen" => PredefinedMenuItem::fullscreen(app, None)?,
                    "bring_all_to_front" => PredefinedMenuItem::bring_all_to_front(app, None)?,
                    _ => unreachable!("unknown native menu item"),
                };
                submenu.append(&predefined)?;
            } else if let (Some(id), Some(title)) = (item.id, item.title) {
                submenu.append(&MenuItem::with_id(app, &id, title, id == "window.close", item.accelerator)?)?;
            }
        }
        #[cfg(target_os = "macos")]
        if group.title == "Window" { submenu.set_as_windows_menu_for_nsapp()?; }
        menu.append(&submenu)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if let Some(window) = app.get_webview_window("main") {
            if id == "window.close" || id == "window.quit" {
                let _ = window.close();
            } else {
                let _ = window.emit("menu:command", id);
            }
        }
    });
    Ok(())
}

/// Only known catalogue commands can be enabled; native editing/window roles stay native.
#[tauri::command]
pub fn update_menu(app: tauri::AppHandle, enabled: Vec<String>) -> Result<(), String> {
    if let Some(menu) = app.menu() {
        for group in menu.items().map_err(|e|e.to_string())? {
            if let Some(submenu) = group.as_submenu() {
                for entry in submenu.items().map_err(|e|e.to_string())? {
                    if let Some(item) = entry.as_menuitem() {
                        let id = item.id().as_ref();
                        if id.starts_with("window.") { continue; }
                        item.set_enabled(enabled.iter().any(|entry|entry == id)).map_err(|e|e.to_string())?;
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_has_unique_commands_and_shortcuts() {
        let mut ids=std::collections::HashSet::new();
        let mut shortcuts=std::collections::HashSet::new();
        let groups=catalogue();
        assert_eq!(groups.iter().map(|g|g.title.as_str()).collect::<Vec<_>>(),vec!["File","Edit","Selection","View","Go","Terminal","Window"]);
        for group in groups {
            assert!(!group.items.is_empty());
            for item in group.items {
                if let Some(id)=item.id { assert!(ids.insert(id),"duplicate command ID");assert!(item.title.is_some()); }
                if let Some(shortcut)=item.accelerator { assert!(shortcuts.insert(shortcut),"duplicate accelerator"); }
            }
        }
    }
}
