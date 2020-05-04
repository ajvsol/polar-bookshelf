import {IDocAnnotation} from "../../../../web/js/annotation_sidebar/DocAnnotation";
import {RepoDocInfo} from "../RepoDocInfo";
import {Sorting} from "../../../../web/spectron0/material-ui/doc_repo_table/Sorting";
import {Mappers} from "polar-shared/src/util/Mapper";
import {AnnotationRepoFilters2} from "./AnnotationRepoFilters2";
import {createObservableStore} from "../../../../web/spectron0/material-ui/store/ObservableStore";
import React from "react";
import {
    IPersistence,
    ITags,
    usePersistence,
    useRepoDocMetaLoader,
    useRepoDocMetaManager,
    useTagsContext
} from "../persistence_layer/PersistenceLayerApp";
import {
    useComponentDidMount,
    useComponentWillUnmount
} from "../../../../web/js/hooks/lifecycle";
import {
    TagSidebarEventForwarder,
    TagSidebarEventForwarderContext
} from "../store/TagSidebarEventForwarder";
import {Preconditions} from "polar-shared/src/Preconditions";
import {Debouncers} from "polar-shared/src/util/Debouncers";
import {Provider} from "polar-shared/src/util/Providers";
import {arrayStream} from "polar-shared/src/util/ArrayStreams";
import {BackendFileRefs} from "../../../../web/js/datastore/BackendFileRefs";
import {Either} from "../../../../web/js/util/Either";
import {SynchronizingDocLoader} from "../util/SynchronizingDocLoader";
import {useDialogManager} from "../../../../web/spectron0/material-ui/dialogs/MUIDialogControllers";
import {DialogManager} from "../../../../web/spectron0/material-ui/dialogs/MUIDialogController";
import {Logger} from "polar-shared/src/logger/Logger";
import {IDocInfo} from "polar-shared/src/metadata/IDocInfo";
import {Tag, Tags} from "polar-shared/src/tags/Tags";
import {AnnotationMutations} from "polar-shared/src/metadata/mutations/AnnotationMutations";
import {MUITagInputControls} from "../MUITagInputControls";
import {
    Exporters,
    ExportFormat
} from "../../../../web/js/metadata/exporter/Exporters";
import {RepoDocMetaLoader} from "../RepoDocMetaLoader";
import {AutocompleteDialogProps} from "../../../../web/js/ui/dialogs/AutocompleteDialog";
import {NULL_FUNCTION} from "polar-shared/src/util/Functions";
import toAutocompleteOption = MUITagInputControls.toAutocompleteOption;
import ComputeNewTagsStrategy = Tags.ComputeNewTagsStrategy;
import {SelectRowType} from "../doc_repo/DocRepoScreen";
import { SelectionEvents } from "../doc_repo/SelectionEvents";

const log = Logger.create();

interface IAnnotationRepoStore {

    readonly data: ReadonlyArray<IDocAnnotation>;
    readonly view: ReadonlyArray<IDocAnnotation>;
    readonly viewPage: ReadonlyArray<IDocAnnotation>;
    /**
     * The selected records as pointers in to viewPage
     */
    readonly selected: ReadonlyArray<number>;
    /**
     * The page number we're viewing
     */
    readonly page: number;

    /**
     * The rows per page we have.
     */
    readonly rowsPerPage: number;


    /**
     * The sorting order.
     */
    readonly order: Sorting.Order,

    /**
     * The column we are sorting by.
     */
    readonly orderBy: keyof RepoDocInfo;

    readonly filter: AnnotationRepoFilters2.Filter;

}

interface IAnnotationRepoCallbacks {

    readonly selectRow: (selectedIdx: number,
                         event: React.MouseEvent,
                         type: SelectRowType) => void;

    /**
     * Called when the user is filtering the UI based on a tag and is narrowing
     * down what's displayed by one or more tag.
     */
    readonly onTagSelected: (tags: ReadonlyArray<Tag>) => void;

    readonly setPage: (page: number) => void;

    readonly setRowsPerPage: (rowsPerPage: number) => void;

    readonly doOpen: (docInfo: IDocInfo) => void;

    readonly doUpdated: (annotation: IDocAnnotation) => void;

    readonly doTagged: (annotations: ReadonlyArray<IDocAnnotation>,
                        tags: ReadonlyArray<Tag>,
                        strategy: ComputeNewTagsStrategy) => void;

    readonly onTagged: () => void;

    readonly doDeleted: (annotations: ReadonlyArray<IDocAnnotation>) => void;

    readonly onDeleted: () => void;

    readonly onExport: (format: ExportFormat) => void;

    readonly setFilter: (filter: Partial<AnnotationRepoFilters2.Filter>) => void;

    readonly onDragStart: (event: React.DragEvent) => void;
    readonly onDragEnd: () => void;

    readonly doDropped: (annotations: ReadonlyArray<IDocAnnotation>, tag: Tag) => void;

    readonly onDropped: (tag: Tag) => void;

}

const initialStore: IAnnotationRepoStore = {
    data: [],
    view: [],
    viewPage: [],
    selected: [],

    page: 0,
    rowsPerPage: 25,
    order: 'desc',
    orderBy: 'progress',

    filter: {
        colors: [],
        text: "",
        tags: [],
        annotationTypes: []
    },
}

interface Mutator {

    doReduceAndUpdateState: (newStore: IAnnotationRepoStore) => void;
    setDataProvider: (dataProvider: DataProvider) => void;
    refresh: () => void;

}

type DataProvider = Provider<ReadonlyArray<IDocAnnotation>>;

function mutatorFactory(storeProvider: Provider<IAnnotationRepoStore>,
                        setStore: (store: IAnnotationRepoStore) => void): Mutator {

    let dataProvider: DataProvider = () => [];

    function doSort(data: ReadonlyArray<IDocAnnotation>) {

        // FIXME: try to move to the same sort infra as the doc repo

        return arrayStream(data)
            .sort((a, b) => {

                const toTimestamp = (val: IDocAnnotation): string => {
                    return val.lastUpdated ?? val.created ?? '';
                };

                return toTimestamp(b).localeCompare(toTimestamp(a));
            })
            .collect();

    }

    function reduce(tmpStore: IAnnotationRepoStore): IAnnotationRepoStore {

        // compute the view, then the viewPage

        // FIXME: we only have to resort and recompute the view when the filters
        // or the sort order changes.

        // FIXME: more sort options...

        // FIXME: try to auto select the first item BUT the problem is that we
        // might not want to do this due to updates that aren't reloading the
        // page.  Make sure all the mutation type would work with this.

        const {data, page, rowsPerPage, filter} = tmpStore;

        // Now that we have new data, we have to also apply the filters and sort
        // order to the results, then update the view + viewPage

        // FIXME: sort with Sorting.stableSort.
        const view = Mappers.create(data)
            .map(current => AnnotationRepoFilters2.execute(current, filter))
            // .map(current => Sorting.stableSort(current, Sorting.getComparator(order, orderBy)))
            .map(current => doSort(current))
            .collect();

        const viewPage = view.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);

        return {...tmpStore, view, viewPage};

    }

    function doReduceAndUpdateState(tmpState: IAnnotationRepoStore) {

        setTimeout(() => {
            const newState = reduce({...tmpState});
            setStore(newState);
        }, 1)

    }

    /**
     * Fetch the latest values from the repoDocMetaManager, then reduce, and
     * apply state.
     */
    function refresh() {
        const store = storeProvider();
        setTimeout(() => {
            const data = dataProvider();
            doReduceAndUpdateState({...store, data});
        }, 1);
    }

    function setDataProvider(newDataProvider: DataProvider) {
        dataProvider = newDataProvider;
    }

    return {doReduceAndUpdateState, refresh, setDataProvider};

}


const createCallbacks = (storeProvider: Provider<IAnnotationRepoStore>,
                         setStore: (store: IAnnotationRepoStore) => void,
                         mutator: Mutator,
                         dialogs: DialogManager,
                         persistence: IPersistence,
                         repoDocMetaLoader: RepoDocMetaLoader,
                         tagsContext: ITags): IAnnotationRepoCallbacks => {

    const synchronizingDocLoader
        = new SynchronizingDocLoader(persistence.persistenceLayerProvider);

    function doOpen(docInfo: IDocInfo): void {

        const backendFileRef = BackendFileRefs.toBackendFileRef(Either.ofRight(docInfo));

        synchronizingDocLoader.load(docInfo.fingerprint, backendFileRef!)
            .catch(err => log.error("Unable to load doc: ", err));

    }

    function selectRow(selectedIdx: number,
                       event: React.MouseEvent,
                       type: SelectRowType) {

        const store = storeProvider();

        const selected = SelectionEvents.selectRow(selectedIdx,
                                                   event,
                                                   type,
                                                   store.selected);

        mutator.doReduceAndUpdateState({
            ...store,
            selected
        });

    }

    /**
     * Called when the user is filtering the UI based on a tag and is narrowing
     * down what's displayed by one or more tag.
     */
    function onTagSelected(tags: ReadonlyArray<Tag>) {

        const store = storeProvider();

        mutator.doReduceAndUpdateState({
            ...store,
            page: 0,
            selected: [],
            filter: {
                ...store.filter,
                tags
            }
        });

    }

    function setPage(page: number) {

        const store = storeProvider();

        mutator.doReduceAndUpdateState({
            ...store,
            page,
            selected: []
        });

    }

    function setRowsPerPage(rowsPerPage: number) {
        const store = storeProvider();

        mutator.doReduceAndUpdateState({
            ...store,
            rowsPerPage,
            page: 0,
            selected: []
        });

    }

    function doDeleted(annotations: ReadonlyArray<IDocAnnotation>) {

        for (const annotation of annotations) {

            // TODO: migrate this to something that can have a progress
            // listener

            const {docMeta, annotationType, original} = annotation;

            AnnotationMutations.delete(docMeta, annotationType, original);

            async function doAsync() {

                await repoDocMetaLoader.update(docMeta, 'deleted');

                const {persistenceLayerProvider} = persistence;
                const persistenceLayer = persistenceLayerProvider();
                await persistenceLayer.writeDocMeta(docMeta);

            }

            doAsync()
            .catch(err => log.error(err));

        }

    }

    function doTagged(annotations: ReadonlyArray<IDocAnnotation>,
                      tags: ReadonlyArray<Tag>,
                      strategy: ComputeNewTagsStrategy = 'set') {

        if (annotations.length === 0) {
            log.warn("No annotations");
            return;
        }

        if (tags.length === 0) {
            log.warn("No tags");
            return;
        }

        for (const annotation of annotations) {

            const docMeta = annotation.docMeta;
            const updates = {
                tags: Tags.toMap(tags)
            };

            AnnotationMutations.update(docMeta,
                                       annotation.annotationType,
                                       {...annotation.original, ...updates});

            const doAsync = async () => {

                await repoDocMetaLoader.update(docMeta, 'updated');

                const {persistenceLayerProvider} = persistence;
                const persistenceLayer = persistenceLayerProvider();
                await persistenceLayer.writeDocMeta(docMeta);

            };

            doAsync()
                .catch(err => log.error(err));

        }

    }

    function onTagged() {

        const annotation = selectedAnnotation();

        if (! annotation) {
            return;
        }

        const {tagsProvider} = tagsContext;

        const availableTags = tagsProvider();

        const existingTags = Object.values(annotation.tags || {});

        // FIXME: make this SET and APPEND here by looking at the
        // mode and whether we're working with 1 item or N items...

        const autocompleteProps: AutocompleteDialogProps<Tag> = {
            title: "Assign Tags to Annotation",
            options: availableTags.map(toAutocompleteOption),
            defaultOptions: existingTags.map(toAutocompleteOption),
            createOption: MUITagInputControls.createOption,
            onCancel: NULL_FUNCTION,
            onChange: NULL_FUNCTION,
            onDone: tags => doTagged([annotation], tags)
        };

        dialogs.autocomplete(autocompleteProps);

    }

    function doUpdated(annotation: IDocAnnotation) {

        const {docMeta, annotationType, original} = annotation;

        AnnotationMutations.update(docMeta, annotationType, original);

        async function doAsync() {

            await repoDocMetaLoader.update(docMeta, 'updated');

            const {persistenceLayerProvider} = persistence;
            const persistenceLayer = persistenceLayerProvider();
            await persistenceLayer.writeDocMeta(docMeta);

        }

        doAsync()
            .catch(err => log.error(err));

    }

    function doExport(format: ExportFormat) {

        const store = storeProvider();;

        async function doAsync() {

            const {persistenceLayerProvider} = persistence;
            await Exporters.doExportForAnnotations(persistenceLayerProvider,
                                                   store.view,
                                                   format);
        }

        doAsync()
        .catch(err => log.error("Unable to download: ", err));

    }

    function onExport(format: ExportFormat) {
        // TODO: we might want to confirm if they are downloading a LARGE
        // number of annotations
        doExport(format);
    }

    function setFilter(filter: Partial<AnnotationRepoFilters2.Filter>) {

        const store = storeProvider();

        mutator.doReduceAndUpdateState({
            ...store,
            filter: {
                ...store.filter,
                ... filter
            }
        });

    }

    function selectedAnnotations(): ReadonlyArray<IDocAnnotation> {

        const store = storeProvider();

        const {selected, viewPage} = store;

        return selected.map(current => viewPage[current]);

    }

    function selectedAnnotation(): IDocAnnotation | undefined {

        const annotations = selectedAnnotations();

        if (annotations.length === 0) {
            return undefined;
        }

        if (annotations.length > 1) {
            throw new Error("Too many selected");
        }

        return annotations[0];

    }

    function onDeleted() {

        const annotations = selectedAnnotations();

        if (annotations.length === 0) {
            log.warn("no repoAnnotation");
            return;
        }

        dialogs.confirm({
            title: "Are you sure you want to delete this item?",
            subtitle: "This is a permanent operation and can't be undone.",
            onAccept: () => doDeleted(annotations)
        })

    }

    function onDragStart(event: React.DragEvent) {
        // noop
    }

    function onDragEnd() {
        // noop
    }

    function doDropped(annotations: ReadonlyArray<IDocAnnotation>, tag: Tag) {
        doTagged(annotations, [tag], 'add');
    }

    function onDropped(tag: Tag) {
        const selected = selectedAnnotations();
        doDropped(selected, tag);
    }

    return {
        doOpen,
        selectRow,
        onTagSelected,
        setPage,
        setRowsPerPage,
        doTagged,
        onTagged,
        onExport,
        setFilter,
        doUpdated,
        doDeleted,
        onDeleted,
        onDragStart,
        onDragEnd,
        doDropped,
        onDropped,
    };

}

function callbacksFactory (storeProvider: Provider<IAnnotationRepoStore>,
                          setStore: (store: IAnnotationRepoStore) => void,
                          mutator: Mutator): IAnnotationRepoCallbacks {

    const dialogs = useDialogManager();
    const persistence = usePersistence();
    const repoDocMetaLoader = useRepoDocMetaLoader();
    const tagsContext = useTagsContext();

    return createCallbacks(storeProvider,
                           setStore,
                           mutator,
                           dialogs,
                           persistence,
                           repoDocMetaLoader,
                           tagsContext);

}

export const [AnnotationRepoStoreProvider, useAnnotationRepoStore, useAnnotationRepoCallbacks, useAnnotationRepoMutator]
    = createObservableStore<IAnnotationRepoStore, Mutator, IAnnotationRepoCallbacks>({
    initialValue: initialStore,
    mutatorFactory,
    callbacksFactory
});

interface IProps {
    readonly children: JSX.Element;
}

/**
 * Once the provider is in place, we load the repo which uses the observer store.
 */
const AnnotationRepoStoreLoader = React.memo((props: IProps) => {

    // TODO: migrate to useRepoDocInfos

    const repoDocMetaLoader = useRepoDocMetaLoader();
    const repoDocMetaManager = useRepoDocMetaManager();
    const annotationRepoMutator = useAnnotationRepoMutator();
    const callbacks = useAnnotationRepoCallbacks();

    const doRefresh = React.useCallback(Debouncers.create(() => {
        annotationRepoMutator.refresh();
    }), []);

    useComponentDidMount(() => {
        annotationRepoMutator.setDataProvider(() => repoDocMetaManager.repoDocAnnotationIndex.values());
        doRefresh();
        repoDocMetaLoader.addEventListener(doRefresh)
    });

    useComponentWillUnmount(() => {

        Preconditions.assertCondition(repoDocMetaLoader.removeEventListener(doRefresh),
                                      "Failed to remove event listener");
    });

    const tagSidebarEventForwarder = React.useMemo<TagSidebarEventForwarder>(() => {
        return {
            onTagSelected: callbacks.onTagSelected,
            onDropped: callbacks.onDropped
        }
    }, [callbacks]);

    return (
        <TagSidebarEventForwarderContext.Provider value={tagSidebarEventForwarder}>
            {props.children}
        </TagSidebarEventForwarderContext.Provider>
    );

});

export const AnnotationRepoStore2 = React.memo((props: IProps) => {

    return (
        <AnnotationRepoStoreProvider>
            <AnnotationRepoStoreLoader>
                {props.children}
            </AnnotationRepoStoreLoader>
        </AnnotationRepoStoreProvider>
    )

});
