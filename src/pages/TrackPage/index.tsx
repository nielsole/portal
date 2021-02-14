import React from 'react'
import {connect} from 'react-redux'
import {Segment, Dimmer, Grid, Loader, Header} from 'semantic-ui-react'
import {useParams} from 'react-router-dom'
import {concat, combineLatest, of, from, Subject} from 'rxjs'
import {pluck, distinctUntilChanged, map, switchMap, startWith, sample} from 'rxjs/operators'
import {useObservable} from 'rxjs-hooks'
import Markdown from 'react-markdown'

import api from 'api'
import {Page} from 'components'
import type {Track, TrackData, TrackComment} from 'types'

import TrackActions from './TrackActions'
import TrackComments from './TrackComments'
import TrackDetails from './TrackDetails'
import TrackMap from './TrackMap'

function useTriggerSubject() {
  const subject$ = React.useMemo(() => new Subject(), [])
  const trigger = React.useCallback(() => subject$.next(null), [])
  return [trigger, subject$]
}

const TrackPage = connect((state) => ({login: state.login}))(function TrackPage({login}) {
  const {slug} = useParams()

  const [reloadComments, reloadComments$] = useTriggerSubject()

  const data: {
    track: null | Track
    trackData: null | TrackData
    comments: null | TrackComment[]
  } | null = useObservable(
    (_$, args$) => {
      const slug$ = args$.pipe(pluck(0), distinctUntilChanged())
      const track$ = slug$.pipe(
        map((slug) => `/tracks/${slug}`),
        switchMap((url) => concat(of(null), from(api.get(url)))),
        pluck('track')
      )

      const trackData$ = slug$.pipe(
        map((slug) => `/tracks/${slug}/data`),
        switchMap((url) => concat(of(null), from(api.get(url)))),
        pluck('trackData'),
        startWith(null) // show track infos before track data is loaded
      )

      const comments$ = concat(of(null), reloadComments$).pipe(
        switchMap(() => slug$),
        map((slug) => `/tracks/${slug}/comments`),
        switchMap((url) => api.get(url)),
        pluck('comments'),
        startWith(null) // show track infos before comments are loaded
      )

      return combineLatest([track$, trackData$, comments$]).pipe(
        map(([track, trackData, comments]) => ({track, trackData, comments}))
      )
    },
    null,
    [slug]
  )

  const onSubmitComment = React.useCallback(async ({body}) => {
    await api.post(`/tracks/${slug}/comments`, {
      body: {comment: {body}},
    })
    reloadComments()
  }, [])

  const onDeleteComment = React.useCallback(async (id) => {
    await api.delete(`/tracks/${slug}/comments/${id}`)
    reloadComments()
  }, [])

  const isAuthor = login?.username === data?.track?.author?.username

  const {track, trackData, comments} = data || {}

  const loading = track == null || trackData == null

  return (
    <Page>
      <Grid stackable>
        <Grid.Row>
          <Grid.Column width={12}>
            <div style={{position: 'relative'}}>
              <Loader active={loading} />
              <Dimmer.Dimmable blurring dimmed={loading}>
                <TrackMap {...{track, trackData}} style={{height: '60vh', minHeight: 400}} />
              </Dimmer.Dimmable>
            </div>
          </Grid.Column>
          <Grid.Column width={4}>
            <Segment>
              {track && (
                <>
                  <Header as="h1">{track.title}</Header>
                  <TrackDetails {...{track, trackData, isAuthor}} />
                  {isAuthor && <TrackActions {...{slug}} />}
                </>
              )}
            </Segment>
          </Grid.Column>
        </Grid.Row>
      </Grid>

      {track?.description && (
        <Segment basic>
          <Header as="h2" dividing>
            Description
          </Header>
          <Markdown>{track.description}</Markdown>
        </Segment>
      )}

      <TrackComments
        {...{hideLoader: loading, comments, login}}
        onSubmit={onSubmitComment}
        onDelete={onDeleteComment}
      />

      {/* <pre>{JSON.stringify(data, null, 2)}</pre> */}
    </Page>
  )
})

export default TrackPage
