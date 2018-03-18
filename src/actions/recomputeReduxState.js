import { numericToCalendar, calendarToNumeric } from "../util/dateHelpers";
import { reallySmallNumber, twoColumnBreakpoint } from "../util/globals";
import { calcBrowserDimensionsInitialState } from "../reducers/browserDimensions";
import { strainNameToIdx, calculateVisiblityAndBranchThickness } from "../util/treeVisibilityHelpers";
import { constructVisibleTipLookupBetweenTrees } from "../util/treeTangleHelpers";
import { calcTipRadii } from "../util/tipRadiusHelpers";
import { getDefaultControlsState } from "../reducers/controls";
import { getValuesAndCountsOfVisibleTraitsFromTree,
  getAllValuesAndCountsOfTraitsFromTree } from "../util/treeCountingHelpers";
import { calcEntropyInView } from "../util/entropy";
import { treeJsonToState } from "../util/treeJsonProcessing";
import { entropyCreateStateFromJsons } from "../util/entropyCreateStateFromJsons";
import { determineColorByGenotypeType, calcNodeColor } from "../util/colorHelpers";
import { calcColorScale } from "../util/colorScale";

export const checkColorByConfidence = (attrs, colorBy) => {
  return colorBy !== "num_date" && attrs.indexOf(colorBy + "_confidence") > -1;
};

const getMinCalDateViaTree = (nodes) => {
  const minNumDate = nodes[0].attr.num_date - 0.01; /* slider should be earlier than actual day */
  return numericToCalendar(minNumDate);
};

const getMaxCalDateViaTree = (nodes) => {
  let maxNumDate = reallySmallNumber;
  nodes.forEach((node) => {
    if (node.attr) {
      if (node.attr.num_date) {
        if (node.attr.num_date > maxNumDate) {
          maxNumDate = node.attr.num_date;
        }
      }
    }
  });
  maxNumDate += 0.01; /* slider should be later than actual day */
  return numericToCalendar(maxNumDate);
};

/* need a (better) way to keep the queryParams all in "sync" */
const modifyStateViaURLQuery = (state, query) => {
  // console.log("Query incoming: ", query);
  if (query.l) {
    state["layout"] = query.l;
  }
  if (query.m) {
    state["distanceMeasure"] = query.m;
  }
  if (query.c) {
    state["colorBy"] = query.c;
  }
  if (query.r) {
    state["geoResolution"] = query.r;
  }
  if (query.p && state.canTogglePanelLayout && (query.p === "full" || query.p === "grid")) {
    state["panelLayout"] = query.p;
  }
  if (query.d) {
    const proposed = query.d.split(",");
    state.panelsToDisplay = state.panelsAvailable.filter((n) => proposed.indexOf(n) !== -1);
    if (state.panelsToDisplay.indexOf("map") === -1 || state.panelsToDisplay.indexOf("tree") === -1) {
      state["panelLayout"] = "full";
    }
  }
  if (query.dmin) {
    state["dateMin"] = query.dmin;
    state["dateMinNumeric"] = calendarToNumeric(query.dmin);
  }
  if (query.dmax) {
    state["dateMax"] = query.dmax;
    state["dateMaxNumeric"] = calendarToNumeric(query.dmax);
  }
  for (const filterKey of Object.keys(query).filter((c) => c.startsWith('f_'))) {
    state.filters[filterKey.replace('f_', '')] = query[filterKey].split(',');
  }
  if (query.animate) {
    const params = query.animate.split(',');
    // console.log("start animation!", params);
    window.NEXTSTRAIN.animationStartPoint = calendarToNumeric(params[0]);
    window.NEXTSTRAIN.animationEndPoint = calendarToNumeric(params[1]);
    state.dateMin = params[0];
    state.dateMax = params[1];
    state.dateMinNumeric = calendarToNumeric(params[0]);
    state.dateMaxNumeric = calendarToNumeric(params[1]);
    state.mapAnimationShouldLoop = params[2] === "1";
    state.mapAnimationCumulative = params[3] === "1";
    state.mapAnimationDurationInMilliseconds = parseInt(params[4], 10);
    state.animationPlayPauseButton = "Pause";
  } else {
    state.animationPlayPauseButton = "Play";
  }
  return state;
};

const restoreQueryableStateToDefaults = (state) => {
  for (const key of Object.keys(state.defaults)) {
    switch (typeof state.defaults[key]) {
      case "string": {
        state[key] = state.defaults[key];
        break;
      }
      case "object": { /* can't use Object.assign, must deep clone instead */
        state[key] = JSON.parse(JSON.stringify(state.defaults[key]));
        break;
      }
      default: {
        console.error("unknown typeof for default state of ", key);
      }
    }
  }
  /* dateMin & dateMax get set to their bounds */
  state["dateMin"] = state["absoluteDateMin"];
  state["dateMax"] = state["absoluteDateMax"];
  state["dateMinNumeric"] = state["absoluteDateMinNumeric"];
  state["dateMaxNumeric"] = state["absoluteDateMaxNumeric"];

  state["panelLayout"] = calcBrowserDimensionsInitialState().width > twoColumnBreakpoint ? "grid" : "full";
  state.panelsToDisplay = state.panelsAvailable.slice();
  // console.log("state now", state);
  return state;
};

const modifyStateViaMetadata = (state, metadata) => {
  if (metadata.date_range) {
    /* this may be useful if, e.g., one were to want to display an outbreak
    from 2000-2005 (the default is the present day) */
    if (metadata.date_range.date_min) {
      state["dateMin"] = metadata.date_range.date_min;
      state["dateMinNumeric"] = calendarToNumeric(state["dateMin"]);
      state["absoluteDateMin"] = metadata.date_range.date_min;
      state["absoluteDateMinNumeric"] = calendarToNumeric(state["absoluteDateMin"]);
      state["mapAnimationStartDate"] = metadata.date_range.date_min;
    }
    if (metadata.date_range.date_max) {
      state["dateMax"] = metadata.date_range.date_max;
      state["dateMaxNumeric"] = calendarToNumeric(state["dateMax"]);
      state["absoluteDateMax"] = metadata.date_range.date_max;
      state["absoluteDateMaxNumeric"] = calendarToNumeric(state["absoluteDateMax"]);
    }
  }
  if (metadata.analysisSlider) {
    state["analysisSlider"] = {key: metadata.analysisSlider, valid: false};
  }
  if (metadata.author_info) {
    state.filters.authors = [];
    state.defaults.filters.authors = [];
  } else {
    console.error("update meta.json to include author_info.");
  }
  if (metadata.filters) {
    metadata.filters.forEach((v) => {
      state.filters[v] = [];
      state.defaults.filters[v] = [];
    });
  } else {
    console.warn("the meta.json did not include any filters");
  }
  if (metadata.defaults) {
    const keysToCheckFor = ["geoResolution", "colorBy", "distanceMeasure", "layout"];
    const expectedTypes = ["string", "string", "string", "string"];

    for (let i = 0; i < keysToCheckFor.length; i += 1) {
      if (metadata.defaults[keysToCheckFor[i]]) {
        if (typeof metadata.defaults[keysToCheckFor[i]] === expectedTypes[i]) { // eslint-disable-line valid-typeof
          /* e.g. if key=geoResoltion, set both state.geoResolution and state.defaults.geoResolution */
          state[keysToCheckFor[i]] = metadata.defaults[keysToCheckFor[i]];
          state.defaults[keysToCheckFor[i]] = metadata.defaults[keysToCheckFor[i]];
        } else {
          console.error("Skipping (meta.json) default for ", keysToCheckFor[i], "as it is not of type ", expectedTypes[i]);
        }
      }
    }
    // TODO: why are these false / False
    if (metadata.defaults.mapTriplicate) {
      // convert string to boolean; default is true; turned off with either false (js) or False (python)
      state["mapTriplicate"] = (metadata.defaults.mapTriplicate === 'false' || metadata.defaults.mapTriplicate === 'False') ? false : true;
    }
  }

  state.panelsAvailable = metadata.panels.slice();
  state.panelsToDisplay = metadata.panels.slice();

  /* if only map or only tree, then panelLayout must be full */
  /* note - this will be overwritten by the URL query */
  if (state.panelsAvailable.indexOf("map") === -1 || state.panelsAvailable.indexOf("tree") === -1) {
    state.panelLayout = "full";
    state.canTogglePanelLayout = false;
  }
  /* annotations in metadata */
  if (!metadata.annotations) {console.error("Metadata needs updating with annotations field. Rerun augur. FATAL.");}
  for (const gene of Object.keys(metadata.annotations)) {
    state.geneLength[gene] = metadata.annotations[gene].end - metadata.annotations[gene].start;
    if (gene !== "nuc") {
      state.geneLength[gene] /= 3;
    }
  }
  return state;
};

const modifyStateViaTree = (state, tree, treeToo) => {
  state["dateMin"] = getMinCalDateViaTree(tree.nodes);
  state["dateMax"] = getMaxCalDateViaTree(tree.nodes);
  state.dateMinNumeric = calendarToNumeric(state.dateMin);
  state.dateMaxNumeric = calendarToNumeric(state.dateMax);

  if (treeToo) {
    const min = getMinCalDateViaTree(treeToo.nodes);
    const max = getMaxCalDateViaTree(treeToo.nodes);
    const minNumeric = calendarToNumeric(min);
    const maxNumeric = calendarToNumeric(max);
    if (minNumeric < state.dateMinNumeric) {
      state.dateMinNumeric = minNumeric;
      state.dateMin = min;
    }
    if (maxNumeric > state.dateMaxNumeric) {
      state.dateMaxNumeric = maxNumeric;
      state.dateMax = max;
    }
  }

  /* set absolutes */
  state["absoluteDateMin"] = state["dateMin"];
  state["absoluteDateMax"] = state["dateMax"];
  state.absoluteDateMinNumeric = calendarToNumeric(state.absoluteDateMin);
  state.absoluteDateMaxNumeric = calendarToNumeric(state.absoluteDateMax);


  /* available tree attrs - based upon the root node */
  if (treeToo) {
    state.attrs = [...new Set([...Object.keys(tree.nodes[0].attr), ...Object.keys(treeToo.nodes[0].attr)])];
  } else {
    state.attrs = Object.keys(tree.nodes[0].attr);
  }

  state.selectedBranchLabel = tree.availableBranchLabels.indexOf("clade") !== -1 ? "clade" : "none";
  state.temporalConfidence = Object.keys(tree.nodes[0].attr).indexOf("num_date_confidence") > -1 ?
    {exists: true, display: true, on: false} : {exists: false, display: false, on: false};
  return state;
};

const checkAndCorrectErrorsInState = (state, metadata) => {
  /* The one (bigish) problem with this being in the reducer is that
  we can't have any side effects. So if we detect and error introduced by
  a URL QUERY (and correct it in state), we can't correct the URL */

  /* colorBy */
  if (Object.keys(metadata.colorOptions).indexOf(state.colorBy) === -1 && !state["colorBy"].startsWith("gt-")) {
    const availableNonGenotypeColorBys = Object.keys(metadata.colorOptions);
    if (availableNonGenotypeColorBys.indexOf("gt") > -1) {
      availableNonGenotypeColorBys.splice(availableNonGenotypeColorBys.indexOf("gt"), 1);
    }
    console.error("Error detected trying to set colorBy to", state.colorBy, "(valid options are", Object.keys(metadata.colorOptions).join(", "), "). Setting to", availableNonGenotypeColorBys[0]);
    state.colorBy = availableNonGenotypeColorBys[0];
    state.defaults.colorBy = availableNonGenotypeColorBys[0];
  }

  /* colorBy confidence */
  state["colorByConfidence"] = checkColorByConfidence(state["attrs"], state["colorBy"]);

  /* distanceMeasure */
  if (["div", "num_date"].indexOf(state["distanceMeasure"]) === -1) {
    state["distanceMeasure"] = "num_date";
    console.error("Error detected. Setting distanceMeasure to ", state["distanceMeasure"]);
  }

  /* geoResolution */
  const availableGeoResultions = Object.keys(metadata.geo);
  if (availableGeoResultions.indexOf(state["geoResolution"]) === -1) {
    state["geoResolution"] = availableGeoResultions[0];
    console.error("Error detected. Setting geoResolution to ", state["geoResolution"]);
  }

  /* temporalConfidence */
  if (state.temporalConfidence.exists) {
    if (state.layout !== "rect") {
      state.temporalConfidence.display = false;
      state.temporalConfidence.on = false;
    } else if (state.distanceMeasure === "div") {
      state.temporalConfidence.display = false;
      state.temporalConfidence.on = false;
    }
  }

  /* if colorBy is a genotype then we need to set mutType */
  const maybeMutType = determineColorByGenotypeType(state.colorBy);
  if (maybeMutType) state.mutType = maybeMutType;

  return state;
};

const modifyTreeStateVisAndBranchThickness = (oldState, tipSelected, controlsState) => {
  /* calculate new branch thicknesses & visibility */
  let tipSelectedIdx = 0;
  /* check if the query defines a strain to be selected */
  if (tipSelected) {
    tipSelectedIdx = strainNameToIdx(oldState.nodes, tipSelected);
    oldState.selectedStrain = tipSelected;
  }
  const visAndThicknessData = calculateVisiblityAndBranchThickness(
    oldState,
    controlsState,
    {dateMinNumeric: controlsState.dateMinNumeric, dateMaxNumeric: controlsState.dateMaxNumeric},
    {tipSelectedIdx, validIdxRoot: oldState.idxOfInViewRootNode}
  );
  visAndThicknessData.stateCountAttrs = Object.keys(controlsState.filters);
  const newState = Object.assign({}, oldState, visAndThicknessData);
  newState.visibleStateCounts = getValuesAndCountsOfVisibleTraitsFromTree(
    newState.nodes, newState.visibility, newState.stateCountAttrs);
  /* potentially VVVV only needs to run if using JSONs */
  newState.totalStateCounts = getAllValuesAndCountsOfTraitsFromTree(newState.nodes, newState.stateCountAttrs);

  if (tipSelectedIdx) { /* i.e. query.s was set */
    newState.tipRadii = calcTipRadii({tipSelectedIdx, colorScale: controlsState.colorScale, newState});
    newState.tipRadiiVersion = 1;
  }
  return newState;
};

export const createStateFromQueryOrJSONs = ({
  JSONs = false, /* raw json data - completely nuke existing redux state */
  oldState = false, /* existing redux state (instead of jsons) */
  query
}) => {
  let tree, treeToo, entropy, controls, metadata;
  /* first task is to create metadata, entropy, controls & tree partial state */
  if (JSONs) {
    /* ceate metadata state */
    metadata = JSONs.meta;
    if (Object.prototype.hasOwnProperty.call(metadata, "loaded")) {
      console.error("Metadata JSON must not contain the key \"loaded\". Ignoring.");
    }
    metadata.colorOptions = metadata.color_options;
    delete metadata.color_options;
    metadata.loaded = true;
    /* entropy state */
    entropy = entropyCreateStateFromJsons(JSONs.meta);
    /* new tree state(s) */
    tree = treeJsonToState(JSONs.tree, JSONs.meta.vaccine_choices);
    tree.debug = "LEFT";
    if (JSONs.treeToo) {
      treeToo = treeJsonToState(JSONs.treeToo, JSONs.meta.vaccine_choices);
      treeToo.debug = "RIGHT";
    }
    /* new controls state - don't apply query yet (or error check!) */
    controls = getDefaultControlsState();
    controls = modifyStateViaTree(controls, tree, treeToo);
    controls = modifyStateViaMetadata(controls, metadata);
  } else if (oldState) {
    ({controls, entropy, tree, treeToo, metadata} = oldState);
    controls = restoreQueryableStateToDefaults(controls);
    if (query.tt && !treeToo.loaded) {
      console.log("TO DO - loAd 2nD tree (via a delayed fetch / now?!?!)");
    }
  } else {
    console.error("no JSONs / oldState provided");
    return;
  }

  /* reconcile control state and URL query */
  controls = modifyStateViaURLQuery(controls, query);
  controls = checkAndCorrectErrorsInState(controls, metadata);

  /* calculate colours if loading from JSONs or if the query demands change */
  if (JSONs || controls.colorBy !== oldState.colorBy) {
    const {colorScale, version} = calcColorScale(controls.colorBy, controls, tree, treeToo, metadata);
    const nodeColors = calcNodeColor(tree, colorScale);
    controls.colorScale = colorScale;
    controls.colorByConfidence = checkColorByConfidence(controls.attrs, controls.colorBy);
    tree.nodeColorsVersion = version;
    tree.nodeColors = nodeColors;
  }

  /* TEMPORARY ONLY */
  if (treeToo) {
    // const tmp = calcColorScaleAndNodeColors(controls.colorBy, controls, treeToo, metadata);
    treeToo.nodeColorsVersion = tree.nodeColorsVersion;
    treeToo.nodeColors = calcNodeColor(treeToo, controls.colorScale);
  }

  tree = modifyTreeStateVisAndBranchThickness(tree, query.s, controls);
  if (treeToo) {
    treeToo = modifyTreeStateVisAndBranchThickness(treeToo, query.s, controls);
    treeToo.tangleTipLookup = constructVisibleTipLookupBetweenTrees(tree.nodes, treeToo.nodes, tree.visibility);
    controls.showTreeToo = query.tt;
    controls.showTangle = true;
    controls.layout = "rect"; /* must be rectangular for two trees */
    const mapIdx = controls.panelsToDisplay.indexOf("map");
    if (mapIdx !== -1) {
      controls.panelsToDisplay = controls.panelsToDisplay.slice();
      controls.panelsToDisplay.splice(mapIdx, 1);
    }
    controls.canTogglePanelLayout = false;
    controls.panelLayout = "full";
  }

  /* calculate entropy in view */
  const [entropyBars, entropyMaxYVal] = calcEntropyInView(tree.nodes, tree.visibility, controls.mutType, entropy.geneMap, entropy.showCounts);
  entropy.bars = entropyBars;
  entropy.maxYVal = entropyMaxYVal;
  // console.log("treetoo:", treeToo);
  return {tree, treeToo, metadata, entropy, controls}; // eslint-disable-line
};


export const createTreeTooState = ({
  treeTooJSON, /* raw json data */
  oldState,
  segment /* name of the treeToo segment */
}) => {
  /* TODO: reconsile choices (filters, colorBys etc) with this new tree */
  /* TODO: reconcile query with visibility etc */
  let controls = oldState.controls;
  /* new tree state */
  let treeToo = treeJsonToState(treeTooJSON);
  treeToo = modifyTreeStateVisAndBranchThickness(treeToo, oldState.tree.selectedStrain, oldState.controls);
  controls = modifyStateViaTree(controls, oldState.tree, treeToo);
  controls.showTreeToo = segment;
  controls.showTangle = true;
  controls.layout = "rect"; /* must be rectangular for two trees */

  /* calculate colours if loading from JSONs or if the query demands change */
  const {colorScale, version} = calcColorScale(controls.colorBy, controls, oldState.tree, treeToo, oldState.metadata);
  const nodeColors = calcNodeColor(treeToo, colorScale);
  controls.colorScale = colorScale;
  controls.colorByConfidence = checkColorByConfidence(controls.attrs, controls.colorBy);
  treeToo.nodeColorsVersion = version;
  treeToo.nodeColors = nodeColors;

  const mapIdx = controls.panelsToDisplay.indexOf("map");
  if (mapIdx !== -1) {
    controls.panelsToDisplay = controls.panelsToDisplay.slice();
    controls.panelsToDisplay.splice(mapIdx, 1);
  }
  controls.canTogglePanelLayout = false;
  controls.panelLayout = "full";
  treeToo.tangleTipLookup = constructVisibleTipLookupBetweenTrees(
    oldState.tree.nodes, treeToo.nodes, oldState.tree.visibility
  );

  // if (tipSelectedIdx) { /* i.e. query.s was set */
  //   tree.tipRadii = calcTipRadii({tipSelectedIdx, colorScale: controls.colorScale, tree});
  //   tree.tipRadiiVersion = 1;
  // }
  treeToo.debug = "RIGHT";
  return {treeToo, controls};
};
