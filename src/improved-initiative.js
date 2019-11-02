import React from "react";
import styled from "@emotion/styled/macro";

export const ImprovedInitiative = ({ improvedInititiveUrl, ...props }) => {
  if (improvedInititiveUrl && improvedInititiveUrl.indexOf("://") === -1) {
    //asume just a code add url prefix
    improvedInititiveUrl =
      "https://www.improved-initiative.com/p/" + improvedInititiveUrl;
  }
  return (
    <ImprovedInitiativeWrapper>
      <iframe
        src={improvedInititiveUrl}
        title="Improved inititive"
        frameBorder="0"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          height: "100%"
        }}
      />
    </ImprovedInitiativeWrapper>
  );
};

const ImprovedInitiativeWrapper = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 350px;
`;
