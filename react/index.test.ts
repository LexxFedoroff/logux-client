import '@testing-library/jest-dom/extend-expect'
import { cleanStores, atom, mapTemplate, MapTemplate } from 'nanostores'
import React, { ReactElement, FC, ReactNode } from 'react'
import { LoguxNotFoundError } from '@logux/actions'
import ReactTesting from '@testing-library/react'
import { delay } from 'nanodelay'
import { jest } from '@jest/globals'

import {
  ChannelNotFoundError,
  ChannelDeniedError,
  changeSyncMapById,
  SyncMapTemplate,
  syncMapTemplate,
  LoguxUndoError,
  createSyncMap,
  ChannelError,
  TestClient
} from '../index.js'
import {
  ClientContext,
  ChannelErrors,
  useClient,
  useFilter,
  useSync,
  useAuth
} from './index.js'

let { render, screen, act } = ReactTesting
let { createElement: h, Component, useState } = React

function getCatcher(cb: () => void): [string[], FC] {
  let errors: string[] = []
  let Catcher: FC = () => {
    try {
      cb()
    } catch (e) {
      if (e instanceof Error) errors.push(e.message)
    }
    return null
  }
  return [errors, Catcher]
}

let Broken = mapTemplate<
  { isLoading: boolean },
  [],
  { loading: Promise<void>; reject(e: Error | string): void }
>(store => {
  store.setKey('isLoading', true)
  store.loading = new Promise<void>((resolve, reject) => {
    store.reject = e => {
      if (typeof e === 'string') {
        reject(
          new LoguxUndoError({
            type: 'logux/undo',
            reason: e,
            id: '',
            action: {
              type: 'logux/subscribe',
              channel: 'A'
            }
          })
        )
      } else {
        reject(e)
      }
    }
  })
})

let IdTest: FC<{ Template: SyncMapTemplate | MapTemplate }> = ({
  Template
}) => {
  let store = useSync(Template, 'ID')
  return h('div', {}, store.isLoading ? 'loading' : store.id)
}

let SyncTest: FC<{ Template: SyncMapTemplate }> = ({ Template }) => {
  let store = useSync(Template, 'ID')
  return h('div', {}, store.isLoading ? 'loading' : store.id)
}

function getText(component: ReactElement): string | null {
  let client = new TestClient('10')
  render(
    h(
      ClientContext.Provider,
      { value: client },
      h('div', { 'data-testid': 'test' }, component)
    )
  )
  return screen.getByTestId('test').textContent
}

function runWithClient(component: ReactElement): void {
  let client = new TestClient('10')
  render(
    h(
      ClientContext.Provider,
      { value: client },
      h(ChannelErrors, { Error: () => null }, component)
    )
  )
}

class ErrorCatcher extends Component {
  state: { message?: string } = {}

  static getDerivedStateFromError(e: Error): object {
    return { message: e.message }
  }

  render(): ReactNode {
    if (typeof this.state.message === 'string') {
      return h('div', {}, this.state.message)
    } else {
      return this.props.children
    }
  }
}

async function catchLoadingError(
  error: string | Error
): Promise<string | null> {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  let Bad: FC = () => h('div', null, 'bad')
  let NotFound: FC<{ error: ChannelNotFoundError | LoguxNotFoundError }> = p =>
    h('div', {}, `404 ${p.error.name}`)
  let AccessDenied: FC<{ error: ChannelDeniedError }> = props => {
    return h('div', {}, `403 ${props.error.action.reason}`)
  }
  let Error: FC<{ error: ChannelError }> = props => {
    return h('div', {}, `500 ${props.error.action.reason}`)
  }

  runWithClient(
    h(
      'div',
      { 'data-testid': 'test' },
      h(
        ErrorCatcher,
        {},
        h(
          ChannelErrors,
          { AccessDenied, NotFound: Bad, Error },
          h(
            ChannelErrors,
            { NotFound },
            h(ChannelErrors, {}, h(IdTest, { Template: Broken }))
          )
        )
      )
    )
  )
  expect(screen.getByTestId('test')).toHaveTextContent('loading')

  await act(async () => {
    Broken('ID').reject(error)
    await delay(1)
  })
  return screen.getByTestId('test').textContent
}

let LocalPost = syncMapTemplate<{ projectId: string; title: string }>('local', {
  offline: true,
  remote: false
})

let RemotePost = syncMapTemplate<{ title?: string }>('posts')

afterEach(() => {
  cleanStores(Broken, LocalPost, RemotePost)
})

it('throws on missed context for sync map', () => {
  let Test = syncMapTemplate<{ name: string }>('test')
  let [errors, Catcher] = getCatcher(() => {
    useSync(Test, 'ID')
  })
  render(h(Catcher))
  expect(errors).toEqual(['Wrap components in Logux <ClientContext.Provider>'])
})

it('throws on missed context for useClient', () => {
  let [errors, Catcher] = getCatcher(() => {
    useClient()
  })
  render(h(Catcher))
  expect(errors).toEqual(['Wrap components in Logux <ClientContext.Provider>'])
})

it('throws store init errors', () => {
  let Template = mapTemplate(() => {
    throw new Error('Test')
  })
  let [errors, Catcher] = getCatcher(() => {
    useSync(Template, 'id')
  })
  runWithClient(h(Catcher))
  expect(errors).toEqual(['Test'])
})

it('throws on missed ID for builder', async () => {
  let store = atom<undefined>()
  let [errors, Catcher] = getCatcher(() => {
    // @ts-expect-error
    useSync(store)
  })
  render(h(Catcher))
  expect(errors).toEqual(['Use useStore() from @nanostores/react for stores'])
})

it('throws and catches not found error', async () => {
  expect(await catchLoadingError(new LoguxNotFoundError())).toBe(
    '404 LoguxNotFoundError'
  )
})

it('throws and catches not found error from server', async () => {
  expect(await catchLoadingError('notFound')).toBe('404 LoguxUndoError')
})

it('throws and catches access denied error', async () => {
  expect(await catchLoadingError('denied')).toBe('403 denied')
})

it('throws and catches access server error during loading', async () => {
  expect(await catchLoadingError('error')).toBe('500 error')
})

it('ignores unknown error', async () => {
  expect(await catchLoadingError(new Error('Test Error'))).toBe('Test Error')
})

it('could process denied via common error component', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  let Error: FC<{ error: ChannelError }> = props => {
    return h('div', {}, `500 ${props.error.action.reason}`)
  }
  runWithClient(
    h(
      'div',
      { 'data-testid': 'test' },
      h(ChannelErrors, { Error }, h(IdTest, { Template: Broken }))
    )
  )
  await act(async () => {
    Broken('ID').reject('denied')
    await delay(1)
  })
  expect(screen.getByTestId('test')).toHaveTextContent('500 denied')
})

it('could process not found via common error component', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  let Error: FC<{ error: ChannelError }> = props => {
    return h('div', {}, `500 ${props.error.action.reason}`)
  }
  runWithClient(
    h(
      'div',
      { 'data-testid': 'test' },
      h(ChannelErrors, { Error }, h(IdTest, { Template: Broken }))
    )
  )
  await act(async () => {
    Broken('ID').reject('notFound')
    await delay(1)
  })
  expect(screen.getByTestId('test')).toHaveTextContent('500 notFound')
})

it('throws an error on missed ChannelErrors', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  expect(
    getText(h(ErrorCatcher, {}, h(SyncTest, { Template: RemotePost })))
  ).toEqual(
    'Wrap components in Logux ' +
      '<ChannelErrors NotFound={Page404} AccessDenied={Page403}>'
  )
})

it('throws an error on ChannelErrors with missed argument', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  expect(
    getText(
      h(
        ErrorCatcher,
        {},
        h(
          ChannelErrors,
          { NotFound: () => null },
          h(SyncTest, { Template: RemotePost })
        )
      )
    )
  ).toEqual(
    'Wrap components in Logux ' +
      '<ChannelErrors NotFound={Page404} AccessDenied={Page403}>'
  )
})

it('does not throw on ChannelErrors with 404 and 403', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  expect(
    getText(
      h(
        ChannelErrors,
        { NotFound: () => null, AccessDenied: () => null },
        h(SyncTest, { Template: RemotePost })
      )
    )
  ).toBe('loading')
})

it('has hook to get client', () => {
  let Test: FC = () => {
    let client = useClient()
    return h('div', {}, client.options.userId)
  }
  let client = new TestClient('10')
  expect(getText(h(ClientContext.Provider, { value: client }, h(Test)))).toBe(
    '10'
  )
})

it('renders filter', async () => {
  let client = new TestClient('10')
  let renders: string[] = []
  let TestList: FC = () => {
    let posts = useFilter(LocalPost, { projectId: '1' })
    renders.push('list')
    return h(
      'ul',
      { 'data-testid': 'test' },
      posts.list.map((post, index) => {
        renders.push(post.id)
        return h('li', { key: post.id }, ` ${index}:${post.title}`)
      })
    )
  }

  render(
    h(
      ClientContext.Provider,
      { value: client },
      h(ChannelErrors, { Error: () => null }, h(TestList))
    )
  )
  expect(screen.getByTestId('test').textContent).toBe('')
  expect(renders).toEqual(['list'])

  await act(async () => {
    await Promise.all([
      createSyncMap(client, LocalPost, { id: '1', projectId: '1', title: 'Y' }),
      createSyncMap(client, LocalPost, { id: '2', projectId: '2', title: 'Y' }),
      createSyncMap(client, LocalPost, { id: '3', projectId: '1', title: 'A' })
    ])
    await delay(10)
  })
  expect(screen.getByTestId('test').textContent).toBe(' 0:Y 1:A')
  expect(renders).toEqual(['list', 'list', '1', '3'])

  await act(async () => {
    await changeSyncMapById(client, LocalPost, '3', 'title', 'B')
    await delay(10)
  })
  expect(screen.getByTestId('test').textContent).toBe(' 0:Y 1:B')
  expect(renders).toEqual(['list', 'list', '1', '3', 'list', '1', '3'])

  await act(async () => {
    await changeSyncMapById(client, LocalPost, '3', 'title', 'Z')
    await delay(10)
  })
  expect(screen.getByTestId('test').textContent).toBe(' 0:Y 1:Z')
  expect(renders).toEqual([
    'list',
    'list',
    '1',
    '3',
    'list',
    '1',
    '3',
    'list',
    '1',
    '3'
  ])
})

it('recreating filter on args changes', async () => {
  let client = new TestClient('10')
  let renders: string[] = []
  let TestList: FC = () => {
    let [filter, setFilter] = useState({ projectId: '1' })
    let posts = useFilter(LocalPost, filter)
    renders.push('list')
    return h(
      'div',
      {},
      h('button', {
        'data-testid': 'change',
        'onClick': () => {
          setFilter({ projectId: '2' })
        }
      }),
      h(
        'ul',
        { 'data-testid': 'test' },
        posts.list.map((post, index) => {
          renders.push(post.id)
          return h('li', { key: index }, ` ${index}:${post.title}`)
        })
      )
    )
  }

  render(
    h(
      ClientContext.Provider,
      { value: client },
      h(ChannelErrors, { Error: () => null }, h(TestList))
    )
  )
  expect(screen.getByTestId('test').textContent).toBe('')
  expect(renders).toEqual(['list'])

  await act(async () => {
    await Promise.all([
      createSyncMap(client, LocalPost, { id: '1', projectId: '1', title: 'Y' }),
      createSyncMap(client, LocalPost, { id: '2', projectId: '2', title: 'Y' }),
      createSyncMap(client, LocalPost, { id: '3', projectId: '1', title: 'A' })
    ])
    await delay(10)
  })
  expect(screen.getByTestId('test').textContent).toBe(' 0:Y 1:A')
  expect(renders).toEqual(['list', 'list', '1', '3'])

  renders.splice(0, renders.length)
  await act(async () => {
    screen.getByTestId('change').click()
    await delay(10)
  })
  expect(renders).toEqual([
    'list', // State is changed
    'list' // Store isLoading changed to false
  ])

  renders.splice(0, renders.length)
  await act(async () => {
    await Promise.all([
      createSyncMap(client, LocalPost, { id: '1', projectId: '1', title: 'Y' }),
      createSyncMap(client, LocalPost, { id: '2', projectId: '2', title: 'Y' }),
      createSyncMap(client, LocalPost, { id: '3', projectId: '1', title: 'A' })
    ])
    await delay(10)
  })
  await delay(10)
  expect(screen.getByTestId('test').textContent).toBe(' 0:Y')
  expect(renders).toEqual(['list', '2'])
})

it('renders authentication state', async () => {
  let client = new TestClient('10')
  let TestProfile: FC = () => {
    let { isAuthenticated, userId } = useAuth()
    return h(
      'div',
      { 'data-testid': 'test' },
      isAuthenticated ? userId : 'loading'
    )
  }
  render(
    h(
      ClientContext.Provider,
      { value: client },
      h(ChannelErrors, { Error: () => null }, h(TestProfile))
    )
  )
  expect(screen.getByTestId('test').textContent).toBe('loading')

  await act(async () => {
    await client.connect()
    await delay(1)
  })
  expect(screen.getByTestId('test').textContent).toBe('10')

  await act(async () => {
    client.disconnect()
    await delay(10)
  })
  expect(screen.getByTestId('test').textContent).toBe('10')

  await act(async () => {
    client.changeUser('20', 'token')
    await client.connect()
    await delay(1)
  })
  expect(screen.getByTestId('test').textContent).toBe('20')

  await act(async () => {
    client.pair.right.send(['error', 'wrong-credentials'])
    client.pair.right.disconnect()
    await client.pair.wait()
    await delay(1)
  })
  expect(screen.getByTestId('test').textContent).toBe('loading')
})
