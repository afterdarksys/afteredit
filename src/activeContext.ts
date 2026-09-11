export type ActiveContext = {
  kube_context: string | null;
  kube_namespace: string | null;
  aws_profile: string | null;
  aws_region: string | null;
  terraform_workspace: string | null;
  production: boolean;
};

/** Fields worth showing, in the order they matter for blast radius. */
export function contextParts(context: ActiveContext): Array<{ label: string; value: string }> {
  const parts: Array<{ label: string; value: string }> = [];
  if (context.kube_context) {
    parts.push({
      label: 'k8s',
      value: context.kube_namespace
        ? `${context.kube_context}/${context.kube_namespace}`
        : context.kube_context,
    });
  }
  if (context.aws_profile) {
    parts.push({
      label: 'aws',
      value: context.aws_region ? `${context.aws_profile} (${context.aws_region})` : context.aws_profile,
    });
  }
  if (context.terraform_workspace) parts.push({ label: 'tf', value: context.terraform_workspace });
  return parts;
}
