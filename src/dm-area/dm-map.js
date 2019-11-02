import React, { useEffect, useRef, useState, useCallback } from "react";

import debounce from "lodash/debounce";
import createPersistedState from "use-persisted-state";
import { PanZoom } from "react-easy-panzoom";
import Referentiel from "referentiel";
import { AlphaPicker, HuePicker } from "react-color";
import parseColor from "parse-color";
import { loadImage, getOptimalDimensions, ConditionalWrap } from "./../util";
import { Toolbar } from "./../toolbar";
import { Input } from "./../input";
import styled from "@emotion/styled/macro";
import { ObjectLayer } from "../object-layer";
import * as Icons from "../feather-icons";
import { ToggleSwitch } from "../toggle-switch";
import { useResetState } from "../hooks/use-reset-state";
import { useOnClickOutside } from "../hooks/use-on-click-outside";
import { useSvgGrid } from "../hooks/use-svg-grid";
import { DmTokenRenderer } from "../object-layer/dm-token-renderer";
import { AreaMarkerRenderer } from "../object-layer/area-marker-renderer";
import { useIsKeyPressed } from "../hooks/use-is-key-pressed";
import { useOnKeyDown } from "../hooks/use-on-key-down";

const ShapeButton = styled.button`
  border: none;
  background-color: transparent;
  color: ${p => (p.isActive ? "rgba(0, 0, 0, 1)" : "hsl(211, 27%, 70%)")};
  &:hover {
    filter: drop-shadow(
      0 0 4px
        ${p => (p.isActive ? "rgba(0, 0, 0, .3)" : "rgba(200, 200, 200, .6)")}
    );
  }
  > svg {
    stroke: ${p => (p.isActive ? "rgba(0, 0, 0, 1)" : "hsl(211, 27%, 70%)")};
  }
`;

const midPointBtw = (p1, p2) => {
  return {
    x: p1.x + (p2.x - p1.x) / 2,
    y: p1.y + (p2.y - p1.y) / 2
  };
};

const distanceBetweenCords = (cords1, cords2) => {
  const a = cords1.x - cords2.x;
  const b = cords1.y - cords2.y;

  const distance = Math.sqrt(a * a + b * b);

  return distance;
};

const orderByProperty = (prop, ...args) => {
  return function(a, b) {
    const equality = a[prop] - b[prop];
    if (equality === 0 && arguments.length > 1) {
      return orderByProperty.apply(null, args)(a, b);
    }
    return equality;
  };
};

const constructCoordinates = (coords, lineWidth) => {
  // Corners
  // 1 - bottom left
  // 2 - top left
  // 3 - top right
  // 4 - bottom right

  // Note: 0,0 starts in top left. Remember this when doing calculations for corners, the y axis calculations
  // need to be flipped vs bottom left orientation

  const r = lineWidth / 2;
  return {
    1: {
      x: coords.x - r,
      y: coords.y + r
    },
    2: {
      x: coords.x - r,
      y: coords.y - r
    },
    3: {
      x: coords.x + r,
      y: coords.y - r
    },
    4: {
      x: coords.x + r,
      y: coords.y + r
    }
  };
};

const findOptimalRhombus = (pointCurrent, pointPrevious, lineWidth) => {
  // Find midpoint between two points
  const midPoint = midPointBtw(pointPrevious, pointCurrent);

  // Exten d points to coordinates
  const pointCurrentCoordinates = constructCoordinates(pointCurrent, lineWidth);
  const pointPreviousCoordinates = constructCoordinates(
    pointPrevious,
    lineWidth
  );

  // Arrays and Objects
  const allPoints = []; // All points are placed into this array
  const counts = {}; // count distinct of distances
  let limitedPoints; // subset of correct points

  // Load the points into allpoints with a field documenting their origin and corner
  for (const key in pointCurrentCoordinates) {
    pointCurrentCoordinates[key].corner = key;
    pointCurrentCoordinates[key].version = 2;
    allPoints.push(pointCurrentCoordinates[key]);
  }
  for (const key in pointPreviousCoordinates) {
    pointPreviousCoordinates[key].corner = key;
    pointPreviousCoordinates[key].version = 1;
    allPoints.push(pointPreviousCoordinates[key]);
  }

  // For each point find the distance between the cord and the midpoint
  for (
    let j = 0, allPointsLength = allPoints.length;
    j < allPointsLength;
    j++
  ) {
    allPoints[j].distance = distanceBetweenCords(
      midPoint,
      allPoints[j]
    ).toFixed(10);
  }

  // count distinct distances into counts object
  allPoints.forEach(function(x) {
    const distance = x.distance;
    counts[distance] = (counts[distance] || 0) + 1;
  });

  // Sort allPoints by distance
  allPoints.sort(function(a, b) {
    return a.distance - b.distance;
  });

  // There are three scenarios
  // 1. the squares are perfectly vertically or horizontally aligned:
  ////  In this case, there will be two distinct lengths between the mid point, In this case, we want to take
  ////  the coordinates with the shortest distance to the midpoint
  // 2. The squares are offset vertically and horizontally. In this case, there will be 3 or 4 distinct lengths between
  ////  the coordinates, 2 that are the shortest, 4 that are in the middle, and 2 that are the longest. We want
  ////  the middle 4

  // Determine the number of distances
  const numberOfDistances = Object.keys(counts).length;

  if (numberOfDistances === 2) {
    limitedPoints = allPoints.slice(0, 4);
  } else if (numberOfDistances === 3 || numberOfDistances === 4) {
    limitedPoints = allPoints.slice(2, 6);
  } else {
    // if the distance is all the same, the square masks haven't moved, so just return
    return;
  }

  // error checking
  if (limitedPoints.length !== 4) {
    throw new Error("unexpected number of points");
  }

  const limitedPointsSorted = limitedPoints.sort(
    orderByProperty("corner", "version")
  );
  if (numberOfDistances > 2) {
    // for horizontally and verically shifted, the sort order needs a small hack so the drawing of the
    // rectangle works correctly
    const temp = limitedPointsSorted[2];
    limitedPointsSorted[2] = limitedPointsSorted[3];
    limitedPointsSorted[3] = temp;
  }
  return limitedPointsSorted;
};

const panZoomContainerStyles = {
  outline: "none",
  height: "100vh",
  width: "100vw"
};

const useModeState = createPersistedState("dm.settings.mode");
const useBrushShapeState = createPersistedState("dm.settings.brushShape");
const useToolState = createPersistedState("dm.settings.tool");
const useLineWidthState = createPersistedState("dm.settings.lineWidth");

const calculateRectProps = (p1, p2) => {
  const width = Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x);
  const height = Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y);
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);

  return { x, y, width, height };
};

const reduceOffsetToMinimum = (offset, sideLength) => {
  const newOffset = offset - sideLength;
  if (newOffset > 0) return reduceOffsetToMinimum(newOffset, sideLength);
  return offset - sideLength;
};

const getNextPossibleLowerValue = (value, maximum, step) => {
  const newValue = value + step;
  if (newValue < maximum) {
    return getNextPossibleLowerValue(newValue, maximum, step);
  }
  return value;
};

const getSnappedSelectionMask = (grid, ratio, selection) => {
  const xMinimum = reduceOffsetToMinimum(
    grid.x * ratio,
    grid.sideLength * ratio
  );
  const yMinimum = reduceOffsetToMinimum(
    grid.y * ratio,
    grid.sideLength * ratio
  );

  const x1 = getNextPossibleLowerValue(
    xMinimum,
    selection.x,
    grid.sideLength * ratio
  );
  const y1 = getNextPossibleLowerValue(
    yMinimum,
    selection.y,
    grid.sideLength * ratio
  );

  const x2 = getNextPossibleLowerValue(
    xMinimum,
    selection.x + selection.width,
    grid.sideLength * ratio
  );
  const y2 = getNextPossibleLowerValue(
    yMinimum,
    selection.y + selection.height,
    grid.sideLength * ratio
  );

  const p1 = { x: x1, y: y1 };
  const p2 = {
    x: x2 + grid.sideLength * ratio,
    y: y2 + grid.sideLength * ratio
  };

  const rect = calculateRectProps(p1, p2);

  // round values because we want the whole area to be affected
  if (rect.x % 1 !== 0) {
    rect.x = Math.floor(rect.x);
    rect.width = Math.ceil(rect.width);
  }
  if (rect.y % 1 !== 0) {
    rect.y = Math.floor(rect.y);
    rect.height = Math.ceil(rect.height);
  }
  return rect;
};

const Cursor = React.memo(
  ({
    coordinates,
    tool,
    brushShape,
    lineWidth,
    areaSelectStart,
    showGrid,
    grid,
    ratio,
    tokenSize
  }) => {
    if (!coordinates) return null;
    if (tool === "area") {
      if (
        areaSelectStart &&
        areaSelectStart.x !== coordinates.x &&
        areaSelectStart.y !== coordinates.y
      ) {
        const selection = calculateRectProps(coordinates, areaSelectStart);

        let snappedSelection = null;
        if (showGrid && grid) {
          const snappedSelectionMask = getSnappedSelectionMask(
            grid,
            ratio,
            selection
          );
          snappedSelection = (
            <rect fill="rgba(0, 255, 255, .5)" {...snappedSelectionMask} />
          );
        }

        return (
          <>
            {snappedSelection}
            <rect
              stroke="aqua"
              strokeWidth="2"
              fill="transparent"
              {...selection}
            />
          </>
        );
      }
      return (
        <g transform={`translate(${coordinates.x}, ${coordinates.y})`}>
          <line
            x1="-10"
            x2="10"
            y2="0"
            y1="0"
            stroke="aqua"
            strokeWidth="2"
          ></line>
          <line
            y1="-10"
            y2="10"
            x1="0"
            x2="0"
            stroke="aqua"
            strokeWidth="2"
          ></line>
        </g>
      );
    } else if (tool === "brush") {
      if (brushShape === "round") {
        return (
          <circle
            cy={coordinates.y}
            cx={coordinates.x}
            r={lineWidth / 2 - 2}
            fill="transparent"
            strokeWidth="2"
            stroke="aqua"
          />
        );
      } else if (brushShape === "square") {
        return (
          <rect
            x={coordinates.x - lineWidth / 2}
            y={coordinates.y - lineWidth / 2}
            width={lineWidth - 2}
            height={lineWidth - 2}
            fill="transparent"
            strokeWidth="2"
            stroke="aqua"
          />
        );
      }
    } else if (tool === "tokens") {
      return (
        <circle
          cx={coordinates.x}
          cy={coordinates.y}
          r={tokenSize}
          strokeWidth="2"
          stroke="aqua"
          fill="transparent"
        />
      );
    }

    return null;
  }
);

const fallbackGridColor = { r: 0, g: 0, b: 0, a: 0.5 };

const buildRGBAColorString = ({ r, g, b, a }) => `rgba(${r}, ${g}, ${b}, ${a})`;
const parseMapColor = input => {
  if (!input) return fallbackGridColor;
  const {
    rgba: [r, g, b, a]
  } = parseColor(input);
  return { r, g, b, a };
};

const DEFAULT_TOKEN_COLOR = "#e91e63";

/**
 * loadedMapId = id of the map that is currently visible in the editor
 * liveMapId = id of the map that is currently visible to the players
 */
export const DmMap = ({
  socket,
  map,
  loadedMapId,
  liveMapId,
  sendLiveMap,
  hideMap,
  showMapModal,
  enterGridMode,
  updateMap,
  deleteToken,
  updateToken,
  dmPassword
}) => {
  const mapContainerRef = useRef(null);
  const mapCanvasRef = useRef(null);
  const mapImageCanvasRef = useRef(null);
  const fogCanvasRef = useRef(null);
  const hasPreviousMap = useRef(false);
  const panZoomRef = useRef(null);
  const panZoomReferentialRef = useRef(null);
  const [cursorCoordinates, setCursorCoodinates] = useState(null);
  const [
    areaSelectionStartCoordinates,
    setAreaSelectionStartCoordinates
  ] = useState(null);
  const [showGridSettings, setShowGridSettings] = useState(false);
  const [showInititiveSettings, setShowInititiveSettings] = useState(false);

  const isAltPressed = useIsKeyPressed("Alt");

  const [gridColor, setGridColor] = useResetState(
    () => parseMapColor(map.gridColor),
    [map.gridColor]
  );
  const [improvedInititiveUrl, setImprovedInititiveUrl] = useResetState(
    () => map.improvedInititiveUrl,
    [map.improvedInititiveUrl]
  );

  const onGridColorChangeComplete = useCallback(() => {
    updateMap(map.id, { gridColor: buildRGBAColorString(gridColor) });
  }, [map, updateMap, gridColor]);

  /**
   * function for saving the fog to the server.
   */
  const saveFogCanvasRef = useRef(null);

  const [mode, setMode] = useModeState("clear");
  const [brushShape, setBrushShape] = useBrushShapeState("square");
  const [tool, setTool] = useToolState("brush"); // "brush" or "area"
  const [lineWidth, setLineWidth] = useLineWidthState(15);

  const tokenColor = DEFAULT_TOKEN_COLOR;
  const tokens = map.tokens || [];

  // marker related stuff
  const [mapCanvasDimensions, setMapCanvasDimensions] = useState({
    width: 0,
    height: 0,
    ratio: 1
  });
  const latestMapCanvasDimensions = useRef(null);
  latestMapCanvasDimensions.current = mapCanvasDimensions;

  const objectSvgRef = useRef(null);
  const [markedAreas, setMarkedAreas] = useState(() => []);
  const tokenSize =
    map && map.grid
      ? (map.grid.sideLength / 2 - map.grid.sideLength * 0.05) *
        mapCanvasDimensions.ratio
      : 15;

  const fillFog = useCallback(() => {
    if (!fogCanvasRef.current) {
      return;
    }
    const context = fogCanvasRef.current.getContext("2d");

    context.globalCompositeOperation = "source-over";
    context.fillStyle = "black";
    context.fillRect(
      0,
      0,
      fogCanvasRef.current.width,
      fogCanvasRef.current.height
    );

    if (saveFogCanvasRef.current) {
      saveFogCanvasRef.current();
    }
    redrawCanvas();
  }, []);

  const constructMask = useCallback(
    coords => {
      const maskDimensions = {
        x: coords.x,
        y: coords.y,
        lineWidth: 2,
        line: "aqua",
        fill: "transparent"
      };

      if (brushShape === "round") {
        maskDimensions.r = lineWidth / 2;
        maskDimensions.startingAngle = 0;
        maskDimensions.endingAngle = Math.PI * 2;
      } else if (brushShape === "square") {
        maskDimensions.centerX = maskDimensions.x - lineWidth / 2;
        maskDimensions.centerY = maskDimensions.y - lineWidth / 2;
        maskDimensions.height = lineWidth;
        maskDimensions.width = lineWidth;
      } else {
        throw new Error("brush shape not found");
      }

      return maskDimensions;
    },
    [brushShape, lineWidth]
  );

  const clearFog = useCallback(() => {
    if (!fogCanvasRef.current) {
      return;
    }
    const context = fogCanvasRef.current.getContext("2d");
    context.clearRect(
      0,
      0,
      fogCanvasRef.current.width,
      fogCanvasRef.current.height
    );

    if (saveFogCanvasRef.current) {
      saveFogCanvasRef.current();
    }
    redrawCanvas();
  }, []);

  const getMapDisplayRatio = useCallback(() => {
    return (
      parseFloat(mapCanvasRef.current.style.width, 10) /
      mapCanvasRef.current.width
    );
  }, []);

  const getMouseCoordinates = useCallback(
    ev => {
      const ratio = getMapDisplayRatio();
      if (!panZoomReferentialRef.current) return { x: 0, y: 0 };
      const [x, y] = panZoomReferentialRef.current.global_to_local([
        ev.pageX,
        ev.pageY
      ]);

      return {
        x: x / ratio,
        y: y / ratio
      };
    },
    [getMapDisplayRatio]
  );

  const getTouchCoordinates = useCallback(
    touch => {
      if (!panZoomReferentialRef.current) {
        throw new TypeError("Invalid state");
      }
      const ratio = getMapDisplayRatio();
      const [x, y] = panZoomReferentialRef.current.global_to_local([
        touch.pageX,
        touch.pageY
      ]);
      return { x: x / ratio, y: y / ratio };
    },
    [getMapDisplayRatio]
  );

  const drawInitial = useCallback(
    coords => {
      const fogMask = constructMask(coords);
      const fogContext = fogCanvasRef.current.getContext("2d");
      fogContext.lineWidth = fogMask.lineWidth;
      if (mode === "clear") {
        fogContext.globalCompositeOperation = "destination-out";
      } else {
        fogContext.globalCompositeOperation = "source-over";
      }

      fogContext.beginPath();
      if (brushShape === "round") {
        fogContext.arc(
          fogMask.x,
          fogMask.y,
          fogMask.r,
          fogMask.startingAngle,
          fogMask.endingAngle,
          true
        );
      } else if (brushShape === "square") {
        fogContext.rect(
          fogMask.centerX,
          fogMask.centerY,
          fogMask.height,
          fogMask.width
        );
      }

      fogContext.fill();
      redrawCanvas();
    },
    [constructMask, brushShape, mode]
  );

  const drawFog = useCallback(
    (lastCoords, coords) => {
      if (!lastCoords) {
        return drawInitial(coords);
      }

      const fogContext = fogCanvasRef.current.getContext("2d");
      if (mode === "clear") {
        fogContext.globalCompositeOperation = "destination-out";
      } else {
        fogContext.globalCompositeOperation = "source-over";
      }

      if (brushShape === "round") {
        fogContext.lineWidth = lineWidth;
        fogContext.lineJoin = fogContext.lineCap = "round";
        fogContext.beginPath();
        fogContext.moveTo(lastCoords.x, lastCoords.y);

        const midPoint = midPointBtw(lastCoords, coords);
        fogContext.quadraticCurveTo(
          lastCoords.x,
          lastCoords.y,
          midPoint.x,
          midPoint.y
        );
        fogContext.lineTo(coords.x, coords.y);
        fogContext.stroke();
      } else if (brushShape === "square") {
        // The goal of this area is to draw lines with a square mask

        // The fundamental issue is that not every position of the mouse is recorded when it is moved
        // around the canvas (particularly when it is moved fast). If it were, we could simply draw a
        // square at every single coordinate

        // a simple approach is to draw an initial square then connect a line to a series of
        // central cords with a square lineCap. Unfortunately, this has undesirable behavior. When moving in
        // a diagonal, the square linecap rotates into a diamond, and "draws" outside of the square mask.

        // Using 'butt' lineCap lines to connect between squares drawn at each set of cords has unexpected behavior.
        // When moving in a diagonal fashion. The width does not correspond to the "face" of the cursor, which
        // maybe longer then the length / width (think hypotenuse) which results in weird drawing.

        // The current solution is two fold
        // 1. Draw a rectangle at every available cord
        // 2. Find and draw the optimal rhombus to connect each square
        fogContext.lineWidth = 1;
        fogContext.beginPath();

        const fowMask = constructMask(lastCoords);
        fogContext.fillRect(
          fowMask.centerX,
          fowMask.centerY,
          fowMask.height,
          fowMask.width
        );

        // optimal polygon to draw to connect two square
        const optimalPoints = findOptimalRhombus(coords, lastCoords, lineWidth);
        if (optimalPoints) {
          fogContext.moveTo(optimalPoints[0].x, optimalPoints[0].y);
          fogContext.lineTo(optimalPoints[1].x, optimalPoints[1].y);
          fogContext.lineTo(optimalPoints[2].x, optimalPoints[2].y);
          fogContext.lineTo(optimalPoints[3].x, optimalPoints[3].y);
          fogContext.fill();
        }
      }
      redrawCanvas();
    },
    [brushShape, constructMask, drawInitial, lineWidth, mode]
  );

  const handleAreaSelection = useCallback(
    (startCoords, endCoords) => {
      const context = fogCanvasRef.current.getContext("2d");

      if (mode === "clear") {
        context.globalCompositeOperation = "destination-out";
      } else {
        context.globalCompositeOperation = "source-over";
      }
      if (map.showGrid) {
        const selectionMask = calculateRectProps(startCoords, endCoords);
        const { x, y, width, height } = getSnappedSelectionMask(
          map.grid,
          mapCanvasDimensions.ratio,
          selectionMask
        );
        context.fillRect(x, y, width, height);
      } else {
        const { x, y, width, height } = calculateRectProps(
          startCoords,
          endCoords
        );
        context.fillRect(x, y, width, height);
      }

      redrawCanvas();
    },
    [mode, map, mapCanvasDimensions.ratio]
  );

  const redrawCanvas = () => {
    const mapContext = mapCanvasRef.current.getContext("2d");
    const { width, height } = mapCanvasRef.current;
    mapContext.globalAlpha = 1;
    mapContext.drawImage(mapImageCanvasRef.current, 0, 0, width, height);
    mapContext.globalAlpha = 0.5;
    mapContext.drawImage(fogCanvasRef.current, 0, 0, width, height);
  };

  const sendMap = useCallback(async () => {
    if (!fogCanvasRef.current) {
      return;
    }
    const blob = await fogCanvasRef.current.convertToBlob();
    sendLiveMap({
      image: new File([blob], "fog.live.png", {
        type: "image/png"
      })
    });
  }, [sendLiveMap]);

  useOnKeyDown(ev => {
    /**
     * overwrite CMD + S
     * @source: https://michilehr.de/overwrite-cmds-and-ctrls-in-javascript/
     */
    if (
      (window.navigator.platform.match("Mac") ? ev.metaKey : ev.ctrlKey) &&
      ev.keyCode === 83
    ) {
      // eslint-disable-next-line default-case
      switch (ev.key) {
        case "s":
          ev.preventDefault();
          sendMap();
          return;
      }
    }

    // eslint-disable-next-line default-case
    switch (ev.key) {
      case "Shift":
        setMode(mode => (mode === "shroud" ? "clear" : "shroud"));
        break;
      case "1":
        setTool("move");
        break;
      case "2":
        setTool("area");
        break;
      case "3":
        setTool("brush");
        break;
      case "4":
        setTool("mark");
        break;
      case "5":
        setTool("tokens");
        break;
    }
  });

  useEffect(() => {
    socket.on("mark area", async data => {
      const { ratio } = latestMapCanvasDimensions.current;
      setMarkedAreas(markedAreas => [
        ...markedAreas,
        {
          id: data.id,
          x: data.x * ratio,
          y: data.y * ratio
        }
      ]);
    });

    return () => {
      socket.off("mark area");
      panZoomReferentialRef.current = null;
    };
  }, [socket]);

  useEffect(() => {
    if (!loadedMapId) {
      return () => {
        hasPreviousMap.current = false;
      };
    }

    const centerMap = (isAnimated = true) => {
      if (!panZoomRef.current) {
        return;
      }
      panZoomRef.current.autoCenter(0.85, isAnimated);
    };

    let tasks = [
      loadImage(`/map/${loadedMapId}/map?authorization=${dmPassword}`),
      loadImage(`/map/${loadedMapId}/fog?authorization=${dmPassword}`)
    ];

    Promise.all([
      tasks[0].promise,
      tasks[1].promise.catch(() => {
        return null;
      })
    ])
      .then(([map, fog]) => {
        tasks = null;
        const dimensions = getOptimalDimensions(
          map.width,
          map.height,
          Math.min(map.width, 3000),
          Math.min(map.height, 8000)
        );
        mapCanvasRef.current.width = dimensions.width;
        mapCanvasRef.current.height = dimensions.height;
        fogCanvasRef.current = new OffscreenCanvas(
          dimensions.width,
          dimensions.height
        );
        mapImageCanvasRef.current = new OffscreenCanvas(
          dimensions.width,
          dimensions.height
        );

        mapImageCanvasRef.current
          .getContext("2d")
          .drawImage(map, 0, 0, dimensions.width, dimensions.height);

        objectSvgRef.current.setAttribute("width", dimensions.width);
        objectSvgRef.current.setAttribute("height", dimensions.height);

        setMapCanvasDimensions(dimensions);

        const widthPx = `${dimensions.width}px`;
        const heightPx = `${dimensions.height}px`;
        mapContainerRef.current.style.width = mapCanvasRef.current.style.width = objectSvgRef.current.style.width = widthPx;
        mapContainerRef.current.style.height = mapCanvasRef.current.style.height = objectSvgRef.current.style.height = heightPx;

        const mapContext = mapCanvasRef.current.getContext("2d");
        mapContext.drawImage(
          mapImageCanvasRef.current,
          0,
          0,
          dimensions.width,
          dimensions.height
        );

        centerMap(false);

        if (!fog) {
          fillFog();
          redrawCanvas();
          return;
        }

        const fogContext = fogCanvasRef.current.getContext("2d");
        fogContext.drawImage(fog, 0, 0, dimensions.width, dimensions.height);

        redrawCanvas();
      })
      .catch(err => {
        // @TODO: distinguish between network error (rertry?) and cancel error
        console.error(err);
      });

    saveFogCanvasRef.current = debounce(async () => {
      if (!fogCanvasRef.current) {
        return;
      }

      const formData = new FormData();
      const blob = await fogCanvasRef.current.convertToBlob();
      formData.append(
        "image",
        new File([blob], "fog.png", {
          type: "image/png"
        })
      );

      await fetch(`/map/${loadedMapId}/fog`, {
        method: "POST",
        body: formData,
        headers: {
          Authorization: dmPassword ? `Bearer ${dmPassword}` : undefined
        }
      });
    }, 500);

    return () => {
      if (tasks) {
        tasks.forEach(task => {
          task.cancel();
        });
      }
      hasPreviousMap.current = true;
      saveFogCanvasRef.current.cancel();
    };
  }, [dmPassword, fillFog, loadedMapId]);

  const isCurrentMapLive = liveMapId && loadedMapId === liveMapId;
  const isOtherMapLive = liveMapId && loadedMapId !== liveMapId;

  const [gridPatternDefinition, gridRectangleElement] = useSvgGrid(
    map.grid,
    mapCanvasDimensions,
    map.showGrid,
    buildRGBAColorString(gridColor)
  );

  let cursor = "default";
  if (tool === "move" || isAltPressed) {
    cursor = "grab";
  } else if (tool === "mark") {
    cursor = "pointer";
  }

  const getRelativePosition = useCallback(
    pageCoordinates => {
      const ref = new Referentiel(panZoomRef.current.dragContainer.current);
      const [x, y] = ref.global_to_local([
        pageCoordinates.x,
        pageCoordinates.y
      ]);
      const { ratio } = mapCanvasDimensions;
      return { x: x / ratio, y: y / ratio };
    },
    [mapCanvasDimensions]
  );

  return (
    <>
      <PanZoom
        disableDoubleClickZoom={tool !== "move"}
        preventPan={() => tool !== "move" && !isAltPressed}
        style={{
          ...panZoomContainerStyles,
          cursor
        }}
        onClick={ev => {
          if (isAltPressed) return;
          const ref = new Referentiel(panZoomRef.current.dragContainer.current);
          const [x, y] = ref.global_to_local([ev.pageX, ev.pageY]);
          const { ratio } = mapCanvasDimensions;
          switch (tool) {
            case "tokens": {
              fetch(`/map/${loadedMapId}/token`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: dmPassword ? `Bearer ${dmPassword}` : undefined
                },
                body: JSON.stringify({
                  x: x / ratio,
                  y: y / ratio,
                  radius: tokenSize,
                  color: tokenColor,
                  label: "1"
                })
              });
              break;
            }

            case "mark": {
              socket.emit("mark area", {
                x: x / ratio,
                y: y / ratio
              });
              break;
            }
            default: {
              return;
            }
          }
        }}
        onStateChange={() => {
          panZoomReferentialRef.current = new Referentiel(
            panZoomRef.current.dragContainer.current
          );
        }}
        ref={panZoomRef}
      >
        <div
          ref={mapContainerRef}
          style={{ backfaceVisibility: "hidden", touchAction: "none" }}
        >
          <canvas ref={mapCanvasRef} style={{ position: "absolute" }} />
          <ObjectLayer
            defs={<>{gridPatternDefinition}</>}
            ref={objectSvgRef}
            onMouseMove={ev => {
              if (tool === "move" || tool === "mark" || isAltPressed) {
                return;
              }

              const coords = getMouseCoordinates(ev);
              setCursorCoodinates(coords);
            }}
            onMouseDown={ev => {
              if (isAltPressed) return;
              const coords = getMouseCoordinates(ev);

              if (tool === "brush") {
                let lastCoords = coords;
                drawInitial(lastCoords);

                const onMouseMove = ev => {
                  const currentCoords = getMouseCoordinates(ev);

                  drawFog(lastCoords, currentCoords);
                  lastCoords = currentCoords;
                };

                const onMouseUp = () => {
                  window.removeEventListener("mousemove", onMouseMove);
                  window.removeEventListener("mouseup", onMouseUp);

                  if (saveFogCanvasRef.current) {
                    saveFogCanvasRef.current();
                  }
                };

                window.addEventListener("mousemove", onMouseMove);
                window.addEventListener("mouseup", onMouseUp);
              } else if (tool === "area") {
                const startCoords = coords;
                setAreaSelectionStartCoordinates(coords);

                const onMouseUp = ev => {
                  window.removeEventListener("mouseup", onMouseUp);
                  window.removeEventListener("keydown", onKeyDown);
                  const endCoords = getMouseCoordinates(ev);

                  handleAreaSelection(startCoords, endCoords);
                  setAreaSelectionStartCoordinates(null);

                  if (saveFogCanvasRef.current) {
                    saveFogCanvasRef.current();
                  }
                };

                const onKeyDown = ev => {
                  if (ev.key === "Escape" && tool === "area") {
                    setAreaSelectionStartCoordinates(null);
                    window.removeEventListener("mouseup", onMouseUp);
                    window.removeEventListener("keydown", onKeyDown);
                  }
                };

                window.addEventListener("mouseup", onMouseUp);
                window.addEventListener("keydown", onKeyDown);
              }
            }}
            onTouchStart={ev => {
              if (tool === "move") {
                return;
              }

              const coords = getTouchCoordinates(ev.touches[0]);
              setCursorCoodinates(coords);

              if (tool === "brush") {
                let lastCoords = coords;
                drawInitial(lastCoords);

                const onTouchMove = ev => {
                  ev.preventDefault();
                  const currentCoords = getTouchCoordinates(ev.touches[0]);
                  setCursorCoodinates(currentCoords);

                  drawFog(lastCoords, currentCoords);
                  lastCoords = currentCoords;
                };

                const onTouchEnd = () => {
                  window.removeEventListener("touchmove", onTouchMove);
                  window.removeEventListener("touchend", onTouchEnd);

                  if (saveFogCanvasRef.current) {
                    saveFogCanvasRef.current();
                  }
                };

                window.addEventListener("touchmove", onTouchMove);
                window.addEventListener("touchend", onTouchEnd);
              } else if (tool === "area") {
                const startCoords = coords;
                let lastTouchCoordinates = coords;
                setAreaSelectionStartCoordinates(coords);

                const onTouchMove = ev => {
                  lastTouchCoordinates = getTouchCoordinates(ev.touches[0]);
                  setCursorCoodinates(lastTouchCoordinates);
                };

                const onTouchEnd = () => {
                  window.removeEventListener("touchmove", onTouchMove);
                  window.removeEventListener("touchend", onTouchEnd);

                  handleAreaSelection(startCoords, lastTouchCoordinates);
                  setAreaSelectionStartCoordinates(null);

                  if (saveFogCanvasRef.current) {
                    saveFogCanvasRef.current();
                  }
                };

                window.addEventListener("touchmove", onTouchMove);
                window.addEventListener("touchend", onTouchEnd);
              }
            }}
            onTouchMove={ev => {
              ev.preventDefault();
            }}
            onContextMenu={ev => {
              ev.preventDefault();
            }}
          >
            {gridRectangleElement}
            <DmTokenRenderer
              tokens={tokens}
              getRelativePosition={getRelativePosition}
              updateToken={updateToken}
              deleteToken={deleteToken}
              ratio={mapCanvasDimensions.ratio}
              isDisabled={isAltPressed}
              contextMenuEnabled={true}
            />
            <AreaMarkerRenderer
              markedAreas={markedAreas}
              setMarkedAreas={setMarkedAreas}
            />
            <g pointerEvents="none">
              {isAltPressed === false ? (
                <Cursor
                  coordinates={cursorCoordinates}
                  tokenSize={tokenSize}
                  tool={tool}
                  brushShape={brushShape}
                  lineWidth={lineWidth}
                  areaSelectStart={areaSelectionStartCoordinates}
                  showGrid={map.showGrid}
                  grid={map.grid}
                  ratio={mapCanvasDimensions.ratio}
                />
              ) : null}
            </g>
          </ObjectLayer>
        </div>
      </PanZoom>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          position: "absolute",
          width: "100%",
          left: 0,
          bottom: 12,
          pointerEvents: "none"
        }}
      >
        <Toolbar horizontal>
          <Toolbar.Group>
            <Toolbar.Item isEnabled={Boolean(map.grid)}>
              <Toolbar.Button
                onClick={() => {
                  if (!map.grid) {
                    enterGridMode();
                  } else {
                    setShowGridSettings(showGridSettings => !showGridSettings);
                  }
                }}
              >
                <Icons.GridIcon />
                <Icons.Label>
                  {map.grid ? "Grid Settings" : "Add Grid"}
                </Icons.Label>
              </Toolbar.Button>
              {showGridSettings ? (
                <ShowGridSettingsPopup
                  gridColor={gridColor}
                  setGridColor={setGridColor}
                  showGrid={map.showGrid}
                  setShowGrid={showGrid => {
                    updateMap(map.id, { showGrid });
                  }}
                  showGridToPlayers={map.showGridToPlayers}
                  setShowGridToPlayers={showGridToPlayers => {
                    updateMap(map.id, { showGridToPlayers });
                  }}
                  onGridColorChangeComplete={onGridColorChangeComplete}
                  onClickOutside={() => {
                    setShowGridSettings(false);
                  }}
                />
              ) : null}
            </Toolbar.Item>
            <Toolbar.Item isEnabled>
              <Toolbar.Button
                onClick={() => {
                  setShowInititiveSettings(
                    showInititiveSettings => !showInititiveSettings
                  );

                  if (showInititiveSettings) {
                    updateMap(map.id, { improvedInititiveUrl });
                  }
                }}
              >
                <Icons.Inbox />
                <Icons.Label>{"Improved Inititive"}</Icons.Label>
              </Toolbar.Button>
              {showInititiveSettings ? (
                <ShowImprovedInititiveSettingsPopup
                  showImprovedInititive={map.showImprovedInititive}
                  improvedInititiveUrl={improvedInititiveUrl}
                  setImprovedInititiveUrl={improvedInititiveUrl => {
                    setImprovedInititiveUrl(improvedInititiveUrl);
                  }}
                  setShowImprovedInititive={showImprovedInititive => {
                    updateMap(map.id, { showImprovedInititive });
                  }}
                  onClickOutside={() => {
                    setShowInititiveSettings(false);
                    updateMap(map.id, { improvedInititiveUrl });
                  }}
                />
              ) : null}
            </Toolbar.Item>

            <Toolbar.Item isEnabled>
              <Toolbar.Button
                onClick={() => {
                  showMapModal();
                }}
              >
                <Icons.MapIcon />
                <Icons.Label>Map Library</Icons.Label>
              </Toolbar.Button>
            </Toolbar.Item>
            <Toolbar.Item>
              <ConditionalWrap
                condition={liveMapId}
                wrap={children => (
                  <Toolbar.Button onClick={hideMap}>{children}</Toolbar.Button>
                )}
              >
                <Icons.PauseIcon
                  style={{
                    stroke:
                      liveMapId !== null
                        ? "hsl(360, 83%, 62%)"
                        : "hsl(211, 27%, 70%)"
                  }}
                />
                <Icons.Label
                  color={
                    liveMapId !== null
                      ? "hsl(360, 83%, 62%)"
                      : "hsl(211, 27%, 70%)"
                  }
                >
                  Stop Sharing
                </Icons.Label>
              </ConditionalWrap>
            </Toolbar.Item>
            {isCurrentMapLive ? (
              <Toolbar.Item>
                <Icons.RadioIcon style={{ stroke: "hsl(160, 51%, 49%)" }} />
                <Icons.Label color="hsl(160, 51%, 49%)">Live</Icons.Label>
              </Toolbar.Item>
            ) : isOtherMapLive ? (
              <Toolbar.Item>
                <Icons.RadioIcon style={{ stroke: "hsl(48, 94%, 68%)" }} />
                <Icons.Label color="hsl(48, 94%, 68%)">Live</Icons.Label>
              </Toolbar.Item>
            ) : (
              <Toolbar.Item>
                <Icons.RadioIcon style={{ stroke: "hsl(211, 27%, 70%)" }} />
                <Icons.Label color="hsl(211, 27%, 70%)">Not Live</Icons.Label>
              </Toolbar.Item>
            )}
            <Toolbar.Item isEnabled>
              <Toolbar.Button onClick={sendMap}>
                <Icons.SendIcon fill="rgba(0, 0, 0, 1)" />
                <Icons.Label>Send</Icons.Label>
              </Toolbar.Button>
            </Toolbar.Item>
          </Toolbar.Group>
        </Toolbar>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          position: "absolute",
          height: "100%",
          top: 0,
          left: 12,
          pointerEvents: "none"
        }}
      >
        <Toolbar>
          <Toolbar.Logo />
          <Toolbar.Group divider>
            <Toolbar.Item isActive={tool === "move"}>
              <Toolbar.Button
                onClick={() => {
                  setTool("move");
                }}
              >
                <Icons.MoveIcon />
                <Icons.Label>Move</Icons.Label>
              </Toolbar.Button>
            </Toolbar.Item>
            <Toolbar.Item isActive={tool === "area"}>
              <Toolbar.Button
                onClick={() => {
                  setTool("area");
                }}
              >
                <Icons.CropIcon />
                <Icons.Label>Select Area</Icons.Label>
              </Toolbar.Button>
            </Toolbar.Item>
            <Toolbar.Item isActive={tool === "brush"}>
              <Toolbar.Button
                onClick={() => {
                  setTool("brush");
                }}
              >
                <Icons.PenIcon />
                <Icons.Label>Brush</Icons.Label>
              </Toolbar.Button>

              {tool === "brush" ? (
                <Toolbar.Popup>
                  <h6>Brush Shape</h6>
                  <div style={{ display: "flex" }}>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <ShapeButton
                        isActive={brushShape === "round"}
                        onClick={() => {
                          setBrushShape("round");
                        }}
                      >
                        <Icons.CircleIcon />
                        <Icons.Label>Circle</Icons.Label>
                      </ShapeButton>
                    </div>
                    <div style={{ flex: 1, textAlign: "right" }}>
                      <ShapeButton
                        isActive={brushShape === "square"}
                        onClick={() => {
                          setBrushShape("square");
                        }}
                      >
                        <Icons.SquareIcon />
                        <Icons.Label>Square</Icons.Label>
                      </ShapeButton>
                    </div>
                  </div>
                  <h6>Brush Size</h6>
                  <input
                    type="range"
                    min="1"
                    max="200"
                    step="1"
                    value={lineWidth}
                    onChange={ev => {
                      setLineWidth(Math.min(200, Math.max(0, ev.target.value)));
                    }}
                  />
                  <div style={{ display: "flex" }}>
                    <div
                      style={{
                        flex: 1,
                        textAlign: "left",
                        fontWeight: "bold",
                        fontSize: 10
                      }}
                    >
                      1
                    </div>
                    <div
                      style={{
                        flex: 1,
                        textAlign: "right",
                        fontWeight: "bold",
                        fontSize: 10
                      }}
                    >
                      200
                    </div>
                  </div>
                </Toolbar.Popup>
              ) : null}
            </Toolbar.Item>
            <Toolbar.Item isActive={tool === "mark"}>
              <Toolbar.Button
                onClick={() => {
                  setTool("mark");
                }}
              >
                <Icons.CrosshairIcon />
                <Icons.Label>Mark</Icons.Label>
              </Toolbar.Button>
            </Toolbar.Item>
            <Toolbar.Item isActive={tool === "tokens"}>
              <Toolbar.Button
                onClick={() => {
                  setTool("tokens");
                }}
              >
                <Icons.TargetIcon />
                <Icons.Label>Token</Icons.Label>
              </Toolbar.Button>
            </Toolbar.Item>
          </Toolbar.Group>
          <Toolbar.Group>
            <Toolbar.Item isEnabled>
              <Toolbar.Button
                onClick={() => {
                  if (mode === "clear") {
                    setMode("shroud");
                  } else {
                    setMode("clear");
                  }
                }}
              >
                {mode === "shroud" ? (
                  <>
                    <Icons.EyeOffIcon fill="rgba(0, 0, 0, 1)" />
                    <Icons.Label>Shroud</Icons.Label>
                  </>
                ) : (
                  <>
                    <Icons.EyeIcon fill="rgba(0, 0, 0, 1)" />
                    <Icons.Label>Reveal</Icons.Label>
                  </>
                )}
              </Toolbar.Button>
            </Toolbar.Item>
            <Toolbar.Item isEnabled>
              <Toolbar.Button onClick={() => fillFog()}>
                <Icons.DropletIcon filled />
                <Icons.Label>Shroud All</Icons.Label>
              </Toolbar.Button>
            </Toolbar.Item>
            <Toolbar.Item isEnabled>
              <Toolbar.Button onClick={() => clearFog()}>
                <Icons.DropletIcon fill="rgba(0, 0, 0, 1)" />
                <Icons.Label>Clear All</Icons.Label>
              </Toolbar.Button>
            </Toolbar.Item>
          </Toolbar.Group>
        </Toolbar>
      </div>
    </>
  );
};

// rerendering this component has a huge impact on performance
const ShowGridSettingsPopup = React.memo(
  ({
    gridColor,
    setGridColor,
    showGrid,
    setShowGrid,
    setShowGridToPlayers,
    showGridToPlayers,
    onGridColorChangeComplete,
    onClickOutside
  }) => {
    const popupRef = useOnClickOutside(onClickOutside);
    const onGridColorChange = useCallback(
      ({ rgb: { r, g, b } }) => {
        setGridColor(({ a }) => ({ r, g, b, a }));
      },
      [setGridColor]
    );
    const onAlphaChange = useCallback(
      ({ rgb: { r, g, b, a } }) => {
        setGridColor({ r, g, b, a });
      },
      [setGridColor]
    );
    return (
      <Toolbar.Popup ref={popupRef}>
        <h4 style={{ textAlign: "left", marginTop: 8 }}>Grid Settings</h4>
        <div>
          <div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                textAlign: "left",
                cursor: "pointer"
              }}
            >
              <div style={{ flexGrow: 1 }}>Show Grid</div>
              <div style={{ marginLeft: 8 }}>
                <ToggleSwitch
                  checked={showGrid}
                  onChange={ev => {
                    setShowGrid(ev.target.checked);
                  }}
                />
              </div>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                textAlign: "left",
                marginTop: 8,
                cursor: "pointer"
              }}
            >
              <div style={{ flexGrow: 1 }}>Show Grid to Players</div>
              <div style={{ marginLeft: 8 }}>
                <ToggleSwitch
                  checked={showGridToPlayers}
                  onChange={ev => {
                    setShowGridToPlayers(ev.target.checked);
                  }}
                />
              </div>
            </label>
          </div>
          <div style={{ marginTop: 16, marginBottom: 8 }}>
            <HuePicker
              color={gridColor}
              onChange={onGridColorChange}
              onChangeComplete={onGridColorChangeComplete}
            />
            <div style={{ height: 16 }} />
            <AlphaPicker
              color={gridColor}
              onChange={onAlphaChange}
              onChangeComplete={onGridColorChangeComplete}
            />
          </div>
        </div>
      </Toolbar.Popup>
    );
  }
);

const ShowImprovedInititiveSettingsPopup = React.memo(
  ({
    improvedInititiveUrl,
    setImprovedInititiveUrl,
    setShowImprovedInititive,
    showImprovedInititive,
    onClickOutside
  }) => {
    const popupRef = useOnClickOutside(onClickOutside);
    return (
      <Toolbar.Popup ref={popupRef}>
        <h4 style={{ textAlign: "left", marginTop: 8 }}>
          Improved Inititive Settings
        </h4>
        <div>
          <div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                textAlign: "left",
                marginTop: 8,
                cursor: "pointer"
              }}
            >
              <div style={{ flexGrow: 1 }}>Show Tracker to Players</div>
              <div style={{ marginLeft: 8 }}>
                <ToggleSwitch
                  checked={showImprovedInititive}
                  onChange={ev => {
                    setShowImprovedInititive(ev.target.checked);
                  }}
                />
              </div>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                textAlign: "left",
                cursor: "pointer"
              }}
            >
              <div style={{ flexGrow: 1 }}>Player Code</div>
              <div style={{ marginLeft: 8 }}>
                <Input
                  placeholder="Url/Code"
                  value={improvedInititiveUrl}
                  onChange={ev => {
                    setImprovedInititiveUrl(ev.target.value);
                  }}
                  style={{ marginBottom: 24 }}
                />
              </div>
            </label>
          </div>

          <a href="https://www.improved-initiative.com/e/" target="blank">
            improved-initiative.com
          </a>
        </div>
      </Toolbar.Popup>
    );
  }
);
