import { Badge } from "@kosmeo-ui/react";
import {
  usePrincipalNames,
  type Principal,
  type PrincipalRef,
} from "../api/usePrincipalNames";

interface PrincipalLabelProps {
  refValue: PrincipalRef;
}

interface ViewProps {
  refValue: PrincipalRef;
  principal: Principal | undefined;
  unavailable: boolean;
}

export const PrincipalLabelView = ({
  refValue,
  principal,
  unavailable,
}: ViewProps) => {
  if (!principal) {
    return (
      <span>
        <code>{refValue.id}</code>
        {unavailable && <small> name unavailable</small>}
      </span>
    );
  }
  if (principal.status === "orphaned") {
    return (
      <span>
        <code>{refValue.id}</code>{" "}
        <Badge variant="warning" size="sm">
          Orphaned
        </Badge>
      </span>
    );
  }
  return (
    <span>
      <span>{principal.name ?? <code>{refValue.id}</code>}</span>
      {principal.email && <small> {principal.email}</small>}
      {principal.status === "inactive" && (
        <>
          {" "}
          <Badge variant="secondary" size="sm">
            Inactive
          </Badge>
        </>
      )}
    </span>
  );
};

export const PrincipalLabel = ({ refValue }: PrincipalLabelProps) => {
  const { get, unavailable } = usePrincipalNames([refValue]);
  return (
    <PrincipalLabelView
      refValue={refValue}
      principal={get(refValue)}
      unavailable={unavailable}
    />
  );
};
