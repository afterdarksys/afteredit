//! Policy evaluation with OPA.
//!
//! Runs the repository's own Rego against a JSON input (a `terraform show
//! -json` plan, a Kubernetes manifest, any config) and maps each violation
//! back to the line that declares the offending resource, so a Spacelift or
//! Conftest failure shows up as a squiggle instead of a CI email.
//!
//! Findings come back shaped like `InfrastructureDiagnostic` so they ride the
//! marker pipeline the editor already has.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

use crate::toolpath::{resolve_binary, tail};

/// Rule names OPA policies conventionally expose, and how loudly to report them.
const RULES: &[(&str, &str)] = &[
    ("deny", "error"),
    ("violation", "error"),
    ("warn", "warning"),
    ("warning", "warning"),
    ("info", "info"),
];

const SKIP_DIRS: &[&str] = &[".git", "node_modules", ".terraform", "target", "dist", "vendor"];
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PolicyFinding {
    pub severity: String,
    /// Package path the rule came from, e.g. `terraform.s3`.
    pub rule: String,
    pub message: String,
    pub resource: Option<String>,
    /// Source file and line, when we could tie the resource to a declaration.
    pub path: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Serialize)]
pub struct PolicyReport {
    pub findings: Vec<PolicyFinding>,
    pub engine: String,
    pub policies: String,
    pub input: String,
    /// Findings we could not tie to a line; still shown, just not as markers.
    pub unlocated: usize,
}

#[derive(Serialize)]
pub struct PolicySources {
    pub policy_dirs: Vec<String>,
    pub inputs: Vec<String>,
    pub opa: Option<String>,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- pure logic

/// A Terraform address reduced to the declaration it refers to.
/// `module.db.aws_rds_cluster.main[0]` -> ("resource", "aws_rds_cluster", "main")
pub fn canonical_address(address: &str) -> Option<(&'static str, String, String)> {
    let mut parts: Vec<String> = address
        .split('.')
        .map(|part| part.split('[').next().unwrap_or(part).to_string())
        .filter(|part| !part.is_empty())
        .collect();

    // Peel `module.<name>` pairs; the declaration lives in the child module,
    // but the type and name still identify it.
    while parts.len() > 2 && parts[0] == "module" {
        parts.drain(0..2);
    }

    let kind = if parts.first().map(String::as_str) == Some("data") {
        parts.remove(0);
        "data"
    } else {
        "resource"
    };

    if parts.len() < 2 {
        return None;
    }
    // The last segment is the local name; the one before it is the type.
    let name = parts.pop()?;
    let type_name = parts.pop()?;
    Some((kind, type_name, name))
}

/// Does this line open the declaration we are looking for?
/// HCL puts them on one line: `resource "aws_s3_bucket" "artifacts" {`
fn declares(line: &str, kind: &str, type_name: &str, name: &str) -> bool {
    let line = line.split('#').next().unwrap_or(line);
    let quoted: Vec<&str> = line.split('"').collect();
    quoted.len() >= 4
        && quoted[0].trim() == kind
        && quoted[1] == type_name
        && quoted[3] == name
}

/// Find the file and 1-based line declaring `address`.
pub fn locate_address(address: &str, files: &[(String, String)]) -> Option<(String, u32)> {
    let (kind, type_name, name) = canonical_address(address)?;
    for (path, content) in files {
        for (index, line) in content.lines().enumerate() {
            if declares(line, kind, &type_name, &name) {
                return Some((path.clone(), index as u32 + 1));
            }
        }
    }
    None
}

/// Pull a Terraform-looking address out of a message, for the common case of
/// `sprintf("%s is not encrypted", [resource.address])`.
pub fn address_in_message(message: &str) -> Option<String> {
    message
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '_' && c != '[' && c != ']' && c != '-'))
        .find(|word| {
            let segments: Vec<&str> = word.split('.').collect();
            segments.len() >= 2
                && segments.iter().all(|s| !s.is_empty())
                && segments[0].chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && word.contains('_')
        })
        .map(str::to_string)
}

/// Walk an `opa eval 'data'` result, collecting every deny/warn/violation
/// array regardless of which package declared it.
pub fn collect_findings(value: &Value) -> Vec<PolicyFinding> {
    let mut findings = Vec::new();
    walk(value, &mut Vec::new(), &mut findings);
    findings
}

fn walk(value: &Value, package: &mut Vec<String>, out: &mut Vec<PolicyFinding>) {
    let Value::Object(map) = value else { return };
    for (key, child) in map {
        if let Some((_, severity)) = RULES.iter().find(|(name, _)| name == key) {
            if let Value::Array(items) = child {
                for item in items {
                    if let Some(finding) = finding_from(item, package.join("."), severity) {
                        out.push(finding);
                    }
                }
                continue;
            }
        }
        package.push(key.clone());
        walk(child, package, out);
        package.pop();
    }
}

fn finding_from(item: &Value, rule: String, severity: &str) -> Option<PolicyFinding> {
    let (message, resource) = match item {
        Value::String(text) => (text.clone(), None),
        Value::Object(fields) => {
            let message = ["msg", "message", "reason"]
                .iter()
                .find_map(|key| fields.get(*key).and_then(Value::as_str))
                .map(str::to_string)?;
            // A structured violation may name the resource outright, which is
            // far better than fishing it out of prose.
            let resource = ["resource", "address", "target"]
                .iter()
                .find_map(|key| fields.get(*key).and_then(Value::as_str))
                .map(str::to_string);
            (message, resource)
        }
        _ => return None,
    };

    let resource = resource.or_else(|| address_in_message(&message));
    Some(PolicyFinding {
        severity: severity.to_string(),
        rule,
        message,
        resource,
        path: None,
        line: None,
        column: None,
    })
}

// ------------------------------------------------------------------- process

fn collect_files(root: &Path, extension: &str, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || out.len() > 4000 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if !name.starts_with('.') || name == ".github" {
                if !SKIP_DIRS.contains(&name.as_ref()) {
                    collect_files(&path, extension, depth + 1, out);
                }
            }
        } else if path.extension().is_some_and(|e| e == extension) {
            out.push(path);
        }
    }
}

/// Where the policies and candidate inputs live in this workspace.
#[tauri::command]
pub async fn policy_discover(root: String) -> Result<PolicySources, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&root);
        let mut rego = Vec::new();
        collect_files(&root, "rego", 0, &mut rego);

        let mut policy_dirs: Vec<String> = rego
            .iter()
            .filter_map(|file| file.parent())
            .map(|dir| dir.display().to_string())
            .collect();
        policy_dirs.sort();
        policy_dirs.dedup();

        let mut json = Vec::new();
        collect_files(&root, "json", 0, &mut json);
        let mut inputs: Vec<String> = json
            .iter()
            .filter(|file| {
                let name = file.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                name.contains("plan") || name.contains("tfstate") || name.contains("manifest")
            })
            .map(|file| file.display().to_string())
            .collect();
        inputs.sort();

        PolicySources {
            policy_dirs,
            inputs,
            opa: resolve_binary("opa").map(|p| p.display().to_string()),
        }
    })
    .await
    .map_err(error)
}

fn evaluate(root: &Path, policies: &Path, input: &Path) -> Result<PolicyReport, String> {
    let opa = resolve_binary("opa")
        .ok_or("OPA is not installed. `brew install opa`, or point AfterEdit at a policy engine.")?;

    let output = Command::new(&opa)
        .arg("eval")
        .arg("--format")
        .arg("json")
        .arg("--data")
        .arg(policies)
        .arg("--input")
        .arg(input)
        .arg("data")
        .output()
        .map_err(|e| format!("could not run {}: {e}", opa.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("opa eval failed: {}", tail(&stderr, 600)));
    }

    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("could not read opa output: {e}"))?;
    let value = parsed
        .pointer("/result/0/expressions/0/value")
        .ok_or("opa returned no result; check the policy package names")?;

    let mut findings = collect_findings(value);

    // Resolve resource addresses against the Terraform sources in the project.
    let mut tf = Vec::new();
    collect_files(root, "tf", 0, &mut tf);
    let sources: Vec<(String, String)> = tf
        .iter()
        .filter_map(|path| {
            fs::read_to_string(path).ok().map(|text| (path.display().to_string(), text))
        })
        .collect();

    let mut unlocated = 0;
    for finding in &mut findings {
        match finding.resource.as_deref().and_then(|address| locate_address(address, &sources)) {
            Some((path, line)) => {
                finding.path = Some(path);
                finding.line = Some(line);
                finding.column = Some(1);
            }
            None => unlocated += 1,
        }
    }

    findings.sort_by(|a, b| a.severity.cmp(&b.severity).then(a.message.cmp(&b.message)));

    Ok(PolicyReport {
        findings,
        engine: opa.display().to_string(),
        policies: policies.display().to_string(),
        input: input.display().to_string(),
        unlocated,
    })
}

#[tauri::command]
pub async fn policy_evaluate(
    root: String,
    policies: String,
    input: String,
) -> Result<PolicyReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        evaluate(Path::new(&root), Path::new(&policies), Path::new(&input))
    })
    .await
    .map_err(error)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> Vec<(String, String)> {
        vec![
            (
                "/w/main.tf".into(),
                concat!(
                    "terraform {\n",
                    "  required_version = \">= 1.6\"\n",
                    "}\n",
                    "\n",
                    "resource \"aws_s3_bucket\" \"artifacts\" {\n",
                    "  bucket = \"x\"\n",
                    "}\n",
                    "\n",
                    "data \"aws_ami\" \"ubuntu\" {\n",
                    "  most_recent = true\n",
                    "}\n",
                    "# resource \"aws_s3_bucket\" \"decoy\" {\n",
                )
                .into(),
            ),
            (
                "/w/db.tf".into(),
                "resource \"aws_rds_cluster\" \"main\" {\n  engine = \"aurora\"\n}\n".into(),
            ),
        ]
    }

    #[test]
    fn addresses_reduce_to_their_declaration() {
        assert_eq!(
            canonical_address("aws_s3_bucket.artifacts"),
            Some(("resource", "aws_s3_bucket".into(), "artifacts".into())),
        );
        // Module prefixes are peeled; the declaration is in the child module.
        assert_eq!(
            canonical_address("module.db.aws_rds_cluster.main"),
            Some(("resource", "aws_rds_cluster".into(), "main".into())),
        );
        assert_eq!(
            canonical_address("module.a.module.b.aws_instance.web"),
            Some(("resource", "aws_instance".into(), "web".into())),
        );
        // for_each / count indices are not part of the declaration.
        assert_eq!(
            canonical_address("aws_instance.web[0]"),
            Some(("resource", "aws_instance".into(), "web".into())),
        );
        assert_eq!(
            canonical_address("data.aws_ami.ubuntu"),
            Some(("data", "aws_ami".into(), "ubuntu".into())),
        );
        assert_eq!(canonical_address("nonsense"), None);
    }

    #[test]
    fn locating_finds_the_declaring_line() {
        let files = sources();
        assert_eq!(locate_address("aws_s3_bucket.artifacts", &files), Some(("/w/main.tf".into(), 5)));
        assert_eq!(locate_address("data.aws_ami.ubuntu", &files), Some(("/w/main.tf".into(), 9)));
        assert_eq!(locate_address("module.db.aws_rds_cluster.main", &files), Some(("/w/db.tf".into(), 1)));
        assert_eq!(locate_address("aws_s3_bucket.missing", &files), None);
    }

    #[test]
    fn a_commented_out_declaration_is_not_a_match() {
        let files = sources();
        assert_eq!(locate_address("aws_s3_bucket.decoy", &files), None);
    }

    #[test]
    fn data_and_resource_of_the_same_name_do_not_collide() {
        let files = vec![(
            "/w/x.tf".into(),
            "data \"aws_ami\" \"shared\" {\n}\nresource \"aws_ami\" \"shared\" {\n}\n".into(),
        )];
        assert_eq!(locate_address("data.aws_ami.shared", &files), Some(("/w/x.tf".into(), 1)));
        assert_eq!(locate_address("aws_ami.shared", &files), Some(("/w/x.tf".into(), 3)));
    }

    #[test]
    fn findings_are_collected_from_any_package() {
        let value: Value = serde_json::from_str(
            r#"{"terraform":{"s3":{"deny":["aws_s3_bucket.artifacts is not encrypted"]},
                 "rds":{"warn":["module.db.aws_rds_cluster.main will be destroyed"]}},
                "kubernetes":{"deny":["missing resource limits"]}}"#,
        )
        .unwrap();

        let findings = collect_findings(&value);
        assert_eq!(findings.len(), 3);

        let deny: Vec<&PolicyFinding> = findings.iter().filter(|f| f.severity == "error").collect();
        assert_eq!(deny.len(), 2);
        let s3 = findings.iter().find(|f| f.rule == "terraform.s3").unwrap();
        assert_eq!(s3.resource.as_deref(), Some("aws_s3_bucket.artifacts"));
        let rds = findings.iter().find(|f| f.rule == "terraform.rds").unwrap();
        assert_eq!(rds.severity, "warning");
    }

    #[test]
    fn structured_violations_use_their_own_resource_field() {
        let value: Value = serde_json::from_str(
            r#"{"main":{"violation":[{"msg":"encryption required","resource":"aws_s3_bucket.logs"}]}}"#,
        )
        .unwrap();
        let findings = collect_findings(&value);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].severity, "error");
        assert_eq!(findings[0].resource.as_deref(), Some("aws_s3_bucket.logs"));
    }

    #[test]
    fn a_message_with_no_address_still_reports() {
        let value: Value =
            serde_json::from_str(r#"{"k8s":{"deny":["containers must set memory limits"]}}"#).unwrap();
        let findings = collect_findings(&value);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].resource, None, "prose without an address must not invent one");
    }

    #[test]
    fn non_rule_keys_are_not_mistaken_for_findings() {
        let value: Value =
            serde_json::from_str(r#"{"cfg":{"denylist":["a","b"],"allowed":true}}"#).unwrap();
        assert!(collect_findings(&value).is_empty());
    }

    /// End to end through the real binary. Skips when OPA is absent.
    #[test]
    fn evaluates_real_rego_against_a_real_plan() {
        if resolve_binary("opa").is_none() {
            eprintln!("skipping: opa is not installed");
            return;
        }
        let root = std::env::temp_dir().join(format!("afteredit-policy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("policies")).unwrap();

        fs::write(
            root.join("policies/s3.rego"),
            "package terraform.s3\n\nimport future.keywords.if\n\n\
             deny contains msg if {\n\
             \tresource := input.resource_changes[_]\n\
             \tresource.type == \"aws_s3_bucket\"\n\
             \tnot resource.change.after.server_side_encryption_configuration\n\
             \tmsg := sprintf(\"%v is not encrypted\", [resource.address])\n\
             }\n",
        )
        .unwrap();

        // Two resources at different lines: a first-match bug would put both
        // findings on the same line.
        fs::write(
            root.join("main.tf"),
            "resource \"aws_s3_bucket\" \"logs\" {\n  bucket = \"l\"\n}\n\nresource \"aws_s3_bucket\" \"artifacts\" {\n  bucket = \"a\"\n}\n",
        )
        .unwrap();

        fs::write(
            root.join("plan.json"),
            r#"{"resource_changes":[
                {"address":"aws_s3_bucket.logs","type":"aws_s3_bucket","change":{"actions":["create"],"after":{}}},
                {"address":"aws_s3_bucket.artifacts","type":"aws_s3_bucket","change":{"actions":["create"],"after":{}}}
            ]}"#,
        )
        .unwrap();

        let report = evaluate(&root, &root.join("policies"), &root.join("plan.json"))
            .expect("evaluation should succeed");

        assert_eq!(report.findings.len(), 2, "{:?}", report.findings);
        assert_eq!(report.unlocated, 0);
        for finding in &report.findings {
            assert_eq!(finding.severity, "error");
            assert_eq!(finding.rule, "terraform.s3");
            assert!(finding.path.as_deref().unwrap().ends_with("main.tf"));
        }

        let line_of = |address: &str| {
            report
                .findings
                .iter()
                .find(|f| f.resource.as_deref() == Some(address))
                .unwrap_or_else(|| panic!("no finding for {address}"))
                .line
        };
        // The point of the whole feature: each violation on its own declaration.
        assert_eq!(line_of("aws_s3_bucket.logs"), Some(1));
        assert_eq!(line_of("aws_s3_bucket.artifacts"), Some(5));

        let _ = fs::remove_dir_all(&root);
    }
}
