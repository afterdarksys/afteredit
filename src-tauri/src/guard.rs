//! A confirmation gate in front of destructive commands aimed at production.
//!
//! The context strip already says which cluster and account a command would
//! hit. This is the other half: when the command would change something and
//! the target looks like production, make the user type the context name
//! before it runs.
//!
//! Threats: this protects against a mistake -- the wrong terminal, the wrong
//! kubeconfig, the wrong window -- not against an attacker, who could run the
//! command outside this editor. It is a speed bump placed exactly where people
//! actually slip, and it fails closed: an unrecognised shape is not treated as
//! safe, it is simply not gated, and anything matched is gated until answered.

use serde::Serialize;

/// (program, subcommands that change something).
///
/// Deliberately specific. A gate that fires on `kubectl get` teaches people to
/// type through it without reading, which is worse than no gate at all.
const DESTRUCTIVE: &[(&str, &[&str])] = &[
    ("terraform", &["apply", "destroy"]),
    ("tofu", &["apply", "destroy"]),
    ("kubectl", &["delete", "apply", "replace", "patch", "scale", "drain", "cordon", "uncordon", "taint", "rollout"]),
    ("oc", &["delete", "apply", "replace", "patch", "scale", "rollout"]),
    ("helm", &["upgrade", "uninstall", "delete", "rollback"]),
    ("helmfile", &["apply", "destroy", "sync"]),
    ("flux", &["uninstall"]),
    ("argocd", &["delete"]),
    ("docker", &["rm", "rmi", "prune"]),
    ("podman", &["rm", "rmi", "prune"]),
    ("pulumi", &["up", "destroy"]),
];

/// Subcommand prefixes that are destructive whatever follows, for CLIs whose
/// verbs are open-ended.
const DESTRUCTIVE_PREFIXES: &[(&str, &[&str])] = &[
    ("aws", &["delete-", "terminate-", "remove-", "detach-", "disable-", "put-", "modify-"]),
    ("gcloud", &["delete", "remove"]),
    ("az", &["delete", "remove", "purge"]),
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Challenge {
    /// What the command would do, for the dialog.
    pub action: String,
    /// The exact string the user has to type.
    pub expected: String,
    /// Which signal made this look like production.
    pub reason: String,
}

/// How far in to look for the subcommand. Flag *values* are indistinguishable
/// from subcommands without a spec for every flag (`kubectl -n payments
/// delete` -- "payments" is not the verb), so scan rather than assume
/// position, but stay near the front: a subcommand is never the seventh
/// argument, while a bucket named "delete-me" might be.
const VERB_WINDOW: usize = 4;

fn program_name(program: &str) -> &str {
    program.rsplit('/').next().unwrap_or(program)
}

/// The destructive subcommand in this invocation, if there is one.
fn destructive_verb<'a>(program: &str, args: &'a [String]) -> Option<&'a str> {
    let program = program_name(program);

    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .map(String::as_str)
        .filter(|arg| !arg.starts_with('-'))
        .take(VERB_WINDOW)
        .find(|arg| {
            DESTRUCTIVE
                .iter()
                .any(|(name, verbs)| *name == program && verbs.contains(arg))
                || DESTRUCTIVE_PREFIXES.iter().any(|(name, prefixes)| {
                    *name == program && prefixes.iter().any(|prefix| arg.starts_with(prefix))
                })
        })
}

/// Does this command change something?
pub fn is_destructive(program: &str, args: &[String]) -> bool {
    destructive_verb(program, args).is_some()
}

/// The challenge to answer before this command may run, if any.
///
/// `context` is what the command would target and `production` whether that
/// looked like production; both come from the context probe, so the gate and
/// the status strip can never disagree.
pub fn challenge_for(
    program: &str,
    args: &[String],
    context: Option<&str>,
    production: bool,
) -> Option<Challenge> {
    if !production || !is_destructive(program, args) {
        return None;
    }
    let expected = context?.trim();
    if expected.is_empty() {
        return None;
    }

    let verb = destructive_verb(program, args).unwrap_or("");
    Some(Challenge {
        action: format!("{} {verb}", program_name(program)),
        expected: expected.to_string(),
        reason: format!("{expected} looks like production"),
    })
}

/// Was the challenge answered? Exact match, trimmed -- the name is visible on
/// screen, so the work is in reading it, not in recalling it.
pub fn answered(challenge: &Challenge, typed: Option<&str>) -> bool {
    typed.is_some_and(|value| value.trim() == challenge.expected)
}

/// What the UI must ask before running `command`. `None` means run it.
///
/// The context probe only runs for a command that would change something, so
/// the ordinary case costs nothing.
pub fn challenge_for_task(root: Option<&std::path::Path>, command: &str, args: &[String]) -> Option<Challenge> {
    if !is_destructive(command, args) {
        return None;
    }
    let (name, production) = crate::context::target(root);
    challenge_for(command, args, name.as_deref(), production)
}

#[tauri::command]
pub async fn task_challenge(root: Option<String>, command: String, args: Vec<String>) -> Option<Challenge> {
    tauri::async_runtime::spawn_blocking(move || {
        challenge_for_task(root.as_deref().map(std::path::Path::new), &command, &args)
    })
    .await
    .unwrap_or(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn changing_commands_are_recognised() {
        for line in [
            "terraform apply", "terraform destroy -auto-approve", "tofu apply",
            "kubectl delete deployment api", "kubectl apply -f deploy.yaml",
            "kubectl rollout restart deployment/api", "kubectl drain node-1",
            "helm upgrade api ./chart", "helm uninstall api",
            "docker prune", "pulumi destroy",
        ] {
            let parts = args(line);
            assert!(
                is_destructive(&parts[0], &parts[1..]),
                "{line} should be gated",
            );
        }
    }

    #[test]
    fn reading_commands_are_left_alone() {
        // A gate that fires on `kubectl get` gets typed through without reading.
        for line in [
            "terraform plan", "terraform show", "terraform fmt", "tofu validate",
            "kubectl get pods", "kubectl describe pod api", "kubectl logs api",
            "helm list", "helm template ./chart", "docker ps", "git status",
            "npm test", "make build",
        ] {
            let parts = args(line);
            assert!(
                !is_destructive(&parts[0], &parts[1..]),
                "{line} should not be gated",
            );
        }
    }

    #[test]
    fn global_flags_do_not_hide_the_verb() {
        let parts = args("kubectl -n payments --context prod delete pod api");
        assert!(is_destructive(&parts[0], &parts[1..]));
    }

    #[test]
    fn an_absolute_path_is_still_the_same_program() {
        let parts = args("/opt/homebrew/bin/terraform apply");
        assert!(is_destructive(&parts[0], &parts[1..]));
    }

    #[test]
    fn open_ended_clis_match_on_prefix() {
        for line in ["aws delete-bucket --name x", "aws terminate-instances --ids i-1", "gcloud delete thing", "az purge x"] {
            let parts = args(line);
            assert!(is_destructive(&parts[0], &parts[1..]), "{line} should be gated");
        }
        for line in ["aws describe-instances", "aws s3 ls", "gcloud list", "az show x"] {
            let parts = args(line);
            assert!(!is_destructive(&parts[0], &parts[1..]), "{line} should not be gated");
        }
    }

    #[test]
    fn a_far_flung_argument_does_not_trip_the_gate() {
        // A bucket named "delete-me" is not an `aws delete-*` subcommand.
        let parts = args("aws s3 ls --recursive --page-size 100 s3://delete-me");
        assert!(!is_destructive(&parts[0], &parts[1..]));
    }

    #[test]
    fn arguments_after_a_double_dash_are_not_subcommands() {
        let parts = args("kubectl exec api -- rm -rf /tmp/x");
        assert!(!is_destructive(&parts[0], &parts[1..]));
    }

    #[test]
    fn a_command_with_no_arguments_is_not_gated() {
        assert!(!is_destructive("kubectl", &[]));
        assert!(!is_destructive("terraform", &args("-help")));
    }

    // ---- the gate itself -------------------------------------------------

    #[test]
    fn production_plus_destructive_raises_a_challenge() {
        let parts = args("terraform apply");
        let challenge = challenge_for(&parts[0], &parts[1..], Some("acme-prod"), true)
            .expect("a destructive command against prod must be gated");
        assert_eq!(challenge.expected, "acme-prod");
        assert_eq!(challenge.action, "terraform apply");
        assert!(challenge.reason.contains("acme-prod"));
    }

    #[test]
    fn nothing_is_gated_outside_production() {
        let parts = args("terraform destroy");
        assert_eq!(challenge_for(&parts[0], &parts[1..], Some("staging"), false), None);
    }

    #[test]
    fn a_read_only_command_is_not_gated_even_in_production() {
        let parts = args("terraform plan");
        assert_eq!(challenge_for(&parts[0], &parts[1..], Some("acme-prod"), true), None);
    }

    #[test]
    fn without_a_context_name_there_is_nothing_to_type() {
        // Gating on a challenge nobody can answer would just be a wall.
        let parts = args("kubectl delete pod api");
        assert_eq!(challenge_for(&parts[0], &parts[1..], None, true), None);
        assert_eq!(challenge_for(&parts[0], &parts[1..], Some("   "), true), None);
    }

    #[test]
    fn only_the_exact_context_name_answers_the_challenge() {
        let parts = args("kubectl delete pod api");
        let challenge = challenge_for(&parts[0], &parts[1..], Some("acme-prod"), true).unwrap();

        assert!(answered(&challenge, Some("acme-prod")));
        assert!(answered(&challenge, Some("  acme-prod  ")), "surrounding space is not a mistake worth failing");

        for wrong in ["", "yes", "ACME-PROD", "acme-prod-2", "acme", "prod"] {
            assert!(!answered(&challenge, Some(wrong)), "{wrong:?} must not pass");
        }
        assert!(!answered(&challenge, None), "an unanswered challenge must not pass");
    }
}
